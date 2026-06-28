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

  // Implementation of the location selection algorithm
  // Exposed as a dedicated method for independent testability
  async selectLocationForCheckout(
    productId: string, 
    quantity: number, 
    deliveryPincode: string,
    manager?: EntityManager // Allow passing a transactional entity manager
  ): Promise<string | null> {
    const locRepo = manager ? manager.getRepository(Location) : this.locationRepository;

    // 1. Service zone match
    const serviceZoneLocations = await locRepo
      .createQueryBuilder('location')
      .innerJoin('inventory', 'inventory', 'inventory.locationId = location.id')
      .where('location.isActive = :isActive', { isActive: true })
      .andWhere(':pincode = ANY(location.servicePincodes)', { pincode: deliveryPincode })
      .andWhere('inventory.productId = :productId', { productId })
      .andWhere('(inventory.stock - inventory.reserved) >= :quantity', { quantity })
      .orderBy('location.priority', 'ASC')
      .getMany();

    if (serviceZoneLocations.length > 0) {
      return serviceZoneLocations[0].id; // Pick the one with LOWEST priority number
    }

    // 2. Fallback logic
    const outOfStockServiceZoneLocations = await locRepo
      .createQueryBuilder('location')
      .where('location.isActive = :isActive', { isActive: true })
      .andWhere(':pincode = ANY(location.servicePincodes)', { pincode: deliveryPincode })
      .orderBy('location.priority', 'ASC')
      .getMany();

    let referenceCity: string | null = null;
    let referenceState: string | null = null;

    if (outOfStockServiceZoneLocations.length > 0) {
      const bestOutOfStock = outOfStockServiceZoneLocations[0];
      referenceCity = bestOutOfStock.city;
      referenceState = bestOutOfStock.state;
    }

    const activeLocationsWithStock = await locRepo
      .createQueryBuilder('location')
      .innerJoin('inventory', 'inventory', 'inventory.locationId = location.id')
      .where('location.isActive = :isActive', { isActive: true })
      .andWhere('inventory.productId = :productId', { productId })
      .andWhere('(inventory.stock - inventory.reserved) >= :quantity', { quantity })
      .getMany();

    if (activeLocationsWithStock.length === 0) {
      return null;
    }

    if (referenceCity && referenceState) {
      // 2a. same city as...
      const sameCity = activeLocationsWithStock.find(loc => loc.city === referenceCity && loc.state === referenceState);
      if (sameCity) return sameCity.id;

      // 2b. same state
      const sameState = activeLocationsWithStock.find(loc => loc.state === referenceState);
      if (sameState) return sameState.id;
    }

    // 2c. any active location with sufficient stock
    return activeLocationsWithStock[0].id;
  }
}
