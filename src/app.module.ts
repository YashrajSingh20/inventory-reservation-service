import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { LocationsModule } from './locations/locations.module';
import { InventoryModule } from './inventory/inventory.module';
import { CheckoutsModule } from './checkouts/checkouts.module';
import { Product } from './products/entities/product.entity';
import { Location } from './locations/entities/location.entity';
import { Inventory } from './inventory/entities/inventory.entity';
import { Checkout } from './checkouts/entities/checkout.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
      entities: [Product, Location, Inventory, Checkout],
      synchronize: true, // Auto-create schema for this assignment
    }),
    ProductsModule,
    LocationsModule,
    InventoryModule,
    CheckoutsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
