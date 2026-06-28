import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Location } from './entities/location.entity';
import { CreateLocationDto } from './dto/create-location.dto';
import { Inventory } from '../inventory/entities/inventory.entity';

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(Location)
    private readonly locationsRepository: Repository<Location>,
    @InjectRepository(Inventory)
    private readonly inventoryRepository: Repository<Inventory>,
  ) {}

  async create(createLocationDto: CreateLocationDto): Promise<Location> {
    const location = this.locationsRepository.create(createLocationDto);
    return this.locationsRepository.save(location);
  }

  async getInventory(locationId: string) {
    const location = await this.locationsRepository.findOne({ where: { id: locationId } });
    if (!location) {
      throw new NotFoundException(`Location with ID ${locationId} not found`);
    }

    const inventoryRecords = await this.inventoryRepository.find({
      where: { locationId },
      relations: { product: true },
    });

    const products = inventoryRecords.map(inv => ({
      productId: inv.productId,
      productName: inv.product?.name,
      stock: inv.stock,
      reserved: inv.reserved,
      available: inv.stock - inv.reserved,
    }));

    return {
      locationId,
      products,
    };
  }
}
