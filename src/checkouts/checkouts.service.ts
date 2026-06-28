import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Checkout, CheckoutStatus } from './entities/checkout.entity';
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

    // We use a transaction to guarantee that the location selection, stock evaluation,
    // row locking, and checkout creation happen atomically.
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      // 1. Idempotency Check
      const existingCheckout = await manager.findOne(Checkout, {
        where: { idempotencyKey },
      });

      if (existingCheckout) {
        if (existingCheckout.requestPayloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key reused with a different request payload');
        }
        return existingCheckout;
      }

      // 2. Select Location
      const locationId = await this.inventoryService.selectLocationForCheckout(
        createCheckoutDto.productId,
        createCheckoutDto.quantity,
        createCheckoutDto.deliveryPincode,
        manager
      );

      if (!locationId) {
        throw new ConflictException('No location available to fulfill this order');
      }

      // 3. Lock Inventory Row
      // WHY HERE? We found a candidate location. Now we must acquire an exclusive lock
      // (SELECT ... FOR UPDATE) on this specific inventory record before modifying it.
      // This prevents any other concurrent checkout from reserving the same stock.
      // We use pessimistic_write lock to tell Postgres to lock the row.
      const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
        .setLock('pessimistic_write')
        .where('inventory.productId = :productId', { productId: createCheckoutDto.productId })
        .andWhere('inventory.locationId = :locationId', { locationId })
        .getOne();

      if (!inventory) {
        throw new NotFoundException('Inventory record not found');
      }

      // 4. Re-evaluate available stock after lock
      // WHY? Under READ COMMITTED isolation, the inventory row could have been updated
      // by another transaction between our selectLocationForCheckout call and the lock acquisition.
      // We must re-verify that the stock is still sufficient.
      const available = inventory.stock - inventory.reserved;
      if (available < createCheckoutDto.quantity) {
        // In a more sophisticated system, we would retry the selection loop here.
        // For this assignment, failing fast is acceptable and safe.
        throw new ConflictException('Stock became unavailable due to concurrent checkout');
      }

      // 5. Reserve Stock
      inventory.reserved += createCheckoutDto.quantity;
      await manager.save(inventory);

      // 6. Create Checkout
      const checkout = manager.create(Checkout, {
        productId: createCheckoutDto.productId,
        quantity: createCheckoutDto.quantity,
        deliveryPincode: createCheckoutDto.deliveryPincode,
        reservedLocationId: locationId,
        status: CheckoutStatus.RESERVED,
        idempotencyKey,
        requestPayloadHash: payloadHash,
      });

      try {
        return await manager.save(checkout);
      } catch (error) {
        // Handle potential Unique Constraint Violation on idempotencyKey 
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
      const checkout = await manager.findOne(Checkout, { where: { id: checkoutId } });
      if (!checkout) throw new NotFoundException('Checkout not found');
      if (checkout.status !== CheckoutStatus.RESERVED && checkout.status !== CheckoutStatus.ABANDONED) {
        throw new BadRequestException(`Cannot mark success for checkout in status ${checkout.status}`);
      }

      // Lock inventory to safely decrement stock and reserved
      const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
        .setLock('pessimistic_write')
        .where('inventory.productId = :productId', { productId: checkout.productId })
        .andWhere('inventory.locationId = :locationId', { locationId: checkout.reservedLocationId })
        .getOne();

      if (inventory) {
        inventory.stock -= checkout.quantity;
        inventory.reserved -= checkout.quantity;
        await manager.save(inventory);
      }

      checkout.status = CheckoutStatus.SUCCEEDED;
      checkout.retryDeadlineAt = null;
      return manager.save(checkout);
    });
  }

  async markPaymentFailed(checkoutId: string): Promise<Checkout> {
    return this.dataSource.transaction(async (manager) => {
      const checkout = await manager.findOne(Checkout, { where: { id: checkoutId } });
      if (!checkout) throw new NotFoundException('Checkout not found');
      if (checkout.status !== CheckoutStatus.RESERVED && checkout.status !== CheckoutStatus.ABANDONED) {
        throw new BadRequestException(`Cannot fail checkout in status ${checkout.status}`);
      }

      // Release reserved stock
      const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
        .setLock('pessimistic_write')
        .where('inventory.productId = :productId', { productId: checkout.productId })
        .andWhere('inventory.locationId = :locationId', { locationId: checkout.reservedLocationId })
        .getOne();

      if (inventory) {
        inventory.reserved -= checkout.quantity;
        await manager.save(inventory);
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

    const checkout = await this.checkoutRepository.findOne({ where: { id: checkoutId } });
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
    // We fetch all abandoned checkouts past deadline, then process them individually in transactions
    // to keep locks short and avoid deadlocks.
    const abandonedCheckouts = await this.checkoutRepository.createQueryBuilder('checkout')
      .where('checkout.status = :status', { status: CheckoutStatus.ABANDONED })
      .andWhere('checkout.retryDeadlineAt < :now', { now: new Date() })
      .getMany();

    for (const checkout of abandonedCheckouts) {
      try {
        await this.dataSource.transaction(async (manager) => {
          // Re-fetch with lock to ensure it hasn't been changed concurrently
          const currentCheckout = await manager.createQueryBuilder(Checkout, 'checkout')
            .setLock('pessimistic_write')
            .where('checkout.id = :id', { id: checkout.id })
            .getOne();

          if (currentCheckout && currentCheckout.status === CheckoutStatus.ABANDONED && currentCheckout.retryDeadlineAt && currentCheckout.retryDeadlineAt < new Date()) {
            const inventory = await manager.createQueryBuilder(Inventory, 'inventory')
              .setLock('pessimistic_write')
              .where('inventory.productId = :productId', { productId: currentCheckout.productId })
              .andWhere('inventory.locationId = :locationId', { locationId: currentCheckout.reservedLocationId })
              .getOne();

            if (inventory) {
              inventory.reserved -= currentCheckout.quantity;
              await manager.save(inventory);
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
