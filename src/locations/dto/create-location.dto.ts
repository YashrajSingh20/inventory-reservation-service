import { IsString, IsNotEmpty, IsBoolean, IsOptional, IsArray, IsInt } from 'class-validator';

export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  city: string;

  @IsString()
  @IsNotEmpty()
  state: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsArray()
  @IsString({ each: true })
  servicePincodes: string[];

  @IsInt()
  @IsOptional()
  priority?: number;
}
