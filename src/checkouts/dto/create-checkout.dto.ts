import { IsString, IsNotEmpty, IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateCheckoutItemDto } from './create-checkout-item.dto';

export class CreateCheckoutDto {
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CreateCheckoutItemDto)
  items: CreateCheckoutItemDto[];

  @IsString()
  @IsNotEmpty()
  deliveryPincode: string;
}
