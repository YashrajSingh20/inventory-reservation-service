import { IsUUID, IsInt, Min, IsString, IsNotEmpty } from 'class-validator';

export class CreateCheckoutDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  deliveryPincode: string;
}
