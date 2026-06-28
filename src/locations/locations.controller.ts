import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  create(@Body() createLocationDto: CreateLocationDto) {
    return this.locationsService.create(createLocationDto);
  }

  @Get(':id/inventory')
  getInventory(@Param('id') id: string) {
    return this.locationsService.getInventory(id);
  }
}
