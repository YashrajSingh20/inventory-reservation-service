import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { Inventory } from '../inventory/entities/inventory.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Inventory)
    private readonly inventoryRepository: Repository<Inventory>,
  ) {}

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    return this.productsRepository.save(product);
  }

  async getAvailability(productId: string) {
    const product = await this.productsRepository.findOne({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    const inventoryRecords = await this.inventoryRepository.find({
      where: { productId },
      relations: { location: true },
    });

    let totalAvailable = 0;
    const perLocation = inventoryRecords.map(inv => {
      const available = inv.stock - inv.reserved;
      totalAvailable += available;
      return {
        locationId: inv.locationId,
        locationName: inv.location?.name,
        stock: inv.stock,
        reserved: inv.reserved,
        available: available,
      };
    });

    return {
      productId,
      totalAvailable,
      locations: perLocation,
    };
  }
}
