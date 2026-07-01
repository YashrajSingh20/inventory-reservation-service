import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Inventory } from './entities/inventory.entity';
import { AddInventoryDto } from './dto/add-inventory.dto';
import { Location } from '../locations/entities/location.entity';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Inventory)
    private readonly inventoryRepository: Repository<Inventory>,
    @InjectRepository(Location)
    private readonly locationRepository: Repository<Location>,
  ) {}

  async addInventory(addInventoryDto: AddInventoryDto): Promise<Inventory> {
    const { productId, locationId, stock } = addInventoryDto;

    let inventory = await this.inventoryRepository.findOne({
      where: { productId, locationId },
    });

    if (inventory) {
      inventory.stock += stock;
    } else {
      inventory = this.inventoryRepository.create({
        productId,
        locationId,
        stock,
        reserved: 0,
      });
    }

    return this.inventoryRepository.save(inventory);
  }

  // Implementation of the location allocation algorithm (Order Splitting)
  // Exposed as a dedicated method for independent testability
  async allocateLocationsForCheckout(
    productId: string, 
    quantity: number, 
    deliveryPincode: string,
    manager?: EntityManager // Allow passing a transactional entity manager
  ): Promise<{ locationId: string, quantity: number }[] | null> {
    const inventoryRepo = manager ? manager.getRepository(Inventory) : this.inventoryRepository;

    // 1. Fetch all active warehouses that have ANY stock for this product
    const inventoryRecords = await inventoryRepo
      .createQueryBuilder('inventory')
      .innerJoinAndSelect('inventory.location', 'location')
      .where('location.isActive = :isActive', { isActive: true })
      .andWhere('inventory.productId = :productId', { productId })
      .andWhere('(inventory.stock - inventory.reserved) > 0')
      .getMany();

    if (inventoryRecords.length === 0) {
      return null;
    }

    // 2. Sort warehouses using smart routing logic
    inventoryRecords.sort((a, b) => {
      const aServes = a.location.servicePincodes.includes(deliveryPincode);
      const bServes = b.location.servicePincodes.includes(deliveryPincode);
      
      // 1. Pincode match gets highest preference
      if (aServes && !bServes) return -1;
      if (!aServes && bServes) return 1;
      
      // 2. Priority (lowest number first)
      if (a.location.priority !== b.location.priority) {
          return a.location.priority - b.location.priority;
      }
      
      // 3. Fallback: just return 0 to maintain relative order
      return 0;
    });

    // 3. Greedy Allocation (Order Splitting)
    const allocations: { locationId: string, quantity: number }[] = [];
    let remaining = quantity;

    for (const record of inventoryRecords) {
      const available = record.stock - record.reserved;
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      allocations.push({ locationId: record.locationId, quantity: take });
      remaining -= take;

      if (remaining === 0) break;
    }

    if (remaining > 0) {
      // Could not fulfill the ENTIRE requested quantity across all warehouses combined
      return null;
    }

    return allocations;
  }
}
