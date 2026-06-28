import { Controller, Post, Body } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AddInventoryDto } from './dto/add-inventory.dto';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post()
  addInventory(@Body() addInventoryDto: AddInventoryDto) {
    return this.inventoryService.addInventory(addInventoryDto);
  }
}
