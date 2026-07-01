import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Checkout } from './checkout.entity';

@Entity('checkout_items')
export class CheckoutItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Checkout, (checkout) => checkout.items, { onDelete: 'CASCADE' })
  checkout: Checkout;

  @Column('uuid')
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column('uuid', { nullable: true })
  reservedLocationId: string | null;
}
