import { IsUUID, IsInt, Min } from 'class-validator';

export class AddInventoryDto {
  @IsUUID()
  productId: string;

  @IsUUID()
  locationId: string;

  @IsInt()
  @Min(0)
  stock: number;
}
