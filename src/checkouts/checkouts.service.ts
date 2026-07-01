import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Checkout, CheckoutStatus } from './entities/checkout.entity';
import { CheckoutItem } from './entities/checkout-item.entity';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { InventoryService } from '../inventory/inventory.service';
import { Inventory } from '../inventory/entities/inventory.entity';
import * as crypto from 'crypto';

@Injectable()
export class CheckoutsService {
  constructor(
    @InjectRepository(Checkout)
    private readonly checkoutRepository: Repository<Checkout>,
    private readonly inventoryService: InventoryService,
    private readonly dataSource: DataSource,
  ) {}

  private hashPayload(payload: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  async createCheckout(createCheckoutDto: CreateCheckoutDto, idempotencyKey: string): Promise<Checkout> {
    const payloadHash = this.hashPayload(createCheckoutDto);

    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      // 1. Idempotency Check
      const existingCheckout = await manager.findOne(Checkout, {
        where: { idempotencyKey },
        relations: ['items']
      });

      if (existingCheckout) {
        if (existingCheckout.requestPayloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key reused with a different request payload');
        }
        return existingCheckout;
      }

      // Consolidate duplicate products in the request
      const itemMap = new Map<string, number>();
      for (const item of createCheckoutDto.items) {
        itemMap.set(item.productId, (itemMap.get(item.productId) || 0) + item.quantity);
      }
      const consolidatedItems = Array.from(itemMap.entries()).map(([productId, quantity]) => ({ productId, quantity }));

      // 2. Select Locations for all items
      const selections: { productId: string; quantity: number; locationId: string }[] = [];
      for (const item of consolidatedItems) {
        const locationId = await this.inventoryService.selectLocationForCheckout(
          item.productId,
          item.quantity,
          createCheckoutDto.deliveryPincode,
          manager
        );

        if (!locationId) {
          throw new ConflictException(`No location available to fulfill product ${item.productId}`);
        }
        selections.push({ ...item, locationId });
      }

      // 3. Sort selections to prevent deadlocks when locking rows
      selections.sort((a, b) => {
        const pCompare = a.productId.localeCompare(b.productId);
        if (pCompare !== 0) return pCompare;
        return a.locationId.localeCompare(b.locationId);
      });

      // 4. Lock Inventory Rows and Reserve Stock
      const checkoutItems = [];
      for (const selection of selections) {
        const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
          .setLock('pessimistic_write')
          .where('inventory.productId = :productId', { productId: selection.productId })
          .andWhere('inventory.locationId = :locationId', { locationId: selection.locationId })
          .getOne();

        if (!inventory) {
          throw new NotFoundException(`Inventory record not found for product ${selection.productId}`);
        }

        const available = inventory.stock - inventory.reserved;
        if (available < selection.quantity) {
          throw new ConflictException(`Stock became unavailable for product ${selection.productId}`);
        }

        inventory.reserved += selection.quantity;
        await manager.save(inventory);

        const checkoutItem = manager.create(CheckoutItem, {
          productId: selection.productId,
          quantity: selection.quantity,
          reservedLocationId: selection.locationId,
        });
        checkoutItems.push(checkoutItem);
      }

      // 5. Create Checkout
      const checkout = manager.create(Checkout, {
        deliveryPincode: createCheckoutDto.deliveryPincode,
        status: CheckoutStatus.RESERVED,
        idempotencyKey,
        requestPayloadHash: payloadHash,
        items: checkoutItems
      });

      try {
        return await manager.save(checkout);
      } catch (error) {
        if (error.code === '23505') {
          throw new ConflictException('Checkout with this idempotency key already exists');
        }
        throw error;
      }
    });
  }

  // Payment Endpoints
  async markPaymentSuccess(checkoutId: string): Promise<Checkout> {
    return this.dataSource.transaction(async (manager) => {
      const checkout = await manager.findOne(Checkout, { where: { id: checkoutId }, relations: ['items'] });
      if (!checkout) throw new NotFoundException('Checkout not found');
      if (checkout.status !== CheckoutStatus.RESERVED && checkout.status !== CheckoutStatus.ABANDONED) {
        throw new BadRequestException(`Cannot mark success for checkout in status ${checkout.status}`);
      }

      // Sort items to prevent deadlocks
      const sortedItems = [...checkout.items].sort((a, b) => 
        a.productId.localeCompare(b.productId) || (a.reservedLocationId || '').localeCompare(b.reservedLocationId || '')
      );

      for (const item of sortedItems) {
        if (!item.reservedLocationId) continue;
        const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
          .setLock('pessimistic_write')
          .where('inventory.productId = :productId', { productId: item.productId })
          .andWhere('inventory.locationId = :locationId', { locationId: item.reservedLocationId })
          .getOne();

        if (inventory) {
          inventory.stock -= item.quantity;
          inventory.reserved -= item.quantity;
          await manager.save(inventory);
        }
      }

      checkout.status = CheckoutStatus.SUCCEEDED;
      checkout.retryDeadlineAt = null;
      return manager.save(checkout);
    });
  }

  async markPaymentFailed(checkoutId: string): Promise<Checkout> {
    return this.dataSource.transaction(async (manager) => {
      const checkout = await manager.findOne(Checkout, { where: { id: checkoutId }, relations: ['items'] });
      if (!checkout) throw new NotFoundException('Checkout not found');
      if (checkout.status !== CheckoutStatus.RESERVED && checkout.status !== CheckoutStatus.ABANDONED) {
        throw new BadRequestException(`Cannot fail checkout in status ${checkout.status}`);
      }

      // Sort items to prevent deadlocks
      const sortedItems = [...checkout.items].sort((a, b) => 
        a.productId.localeCompare(b.productId) || (a.reservedLocationId || '').localeCompare(b.reservedLocationId || '')
      );

      for (const item of sortedItems) {
        if (!item.reservedLocationId) continue;
        const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
          .setLock('pessimistic_write')
          .where('inventory.productId = :productId', { productId: item.productId })
          .andWhere('inventory.locationId = :locationId', { locationId: item.reservedLocationId })
          .getOne();

        if (inventory) {
          inventory.reserved -= item.quantity;
          await manager.save(inventory);
        }
      }

      checkout.status = CheckoutStatus.FAILED;
      checkout.retryDeadlineAt = null;
      return manager.save(checkout);
    });
  }

  async markPaymentAbandoned(checkoutId: string): Promise<Checkout> {
    const retryWindowMinutes = parseInt(process.env.RETRY_WINDOW_MINUTES || '15', 10);
    const deadline = new Date();
    deadline.setMinutes(deadline.getMinutes() + retryWindowMinutes);

    const checkout = await this.checkoutRepository.findOne({ where: { id: checkoutId }, relations: ['items'] });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status !== CheckoutStatus.RESERVED) {
      throw new BadRequestException(`Cannot abandon checkout in status ${checkout.status}`);
    }

    checkout.status = CheckoutStatus.ABANDONED;
    checkout.retryDeadlineAt = deadline;
    return this.checkoutRepository.save(checkout);
  }

  async sweepExpiredCheckouts(): Promise<number> {
    let expiredCount = 0;
    const abandonedCheckouts = await this.checkoutRepository.createQueryBuilder('checkout')
      .where('checkout.status = :status', { status: CheckoutStatus.ABANDONED })
      .andWhere('checkout.retryDeadlineAt < :now', { now: new Date() })
      .getMany();

    for (const checkout of abandonedCheckouts) {
      try {
        await this.dataSource.transaction(async (manager) => {
          const currentCheckout = await manager.createQueryBuilder(Checkout, 'checkout')
            .setLock('pessimistic_write')
            .leftJoinAndSelect('checkout.items', 'items')
            .where('checkout.id = :id', { id: checkout.id })
            .getOne();

          if (currentCheckout && currentCheckout.status === CheckoutStatus.ABANDONED && currentCheckout.retryDeadlineAt && currentCheckout.retryDeadlineAt < new Date()) {
            
            const sortedItems = [...(currentCheckout.items || [])].sort((a, b) => 
              a.productId.localeCompare(b.productId) || (a.reservedLocationId || '').localeCompare(b.reservedLocationId || '')
            );

            for (const item of sortedItems) {
              if (!item.reservedLocationId) continue;
              const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
                .setLock('pessimistic_write')
                .where('inventory.productId = :productId', { productId: item.productId })
                .andWhere('inventory.locationId = :locationId', { locationId: item.reservedLocationId })
                .getOne();

              if (inventory) {
                inventory.reserved -= item.quantity;
                await manager.save(inventory);
              }
            }

            currentCheckout.status = CheckoutStatus.EXPIRED;
            await manager.save(currentCheckout);
            expiredCount++;
          }
        });
      } catch (error) {
        console.error(`Failed to expire checkout ${checkout.id}`, error);
      }
    }
    return expiredCount;
  }
}
