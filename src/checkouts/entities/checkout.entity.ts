import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { CheckoutItem } from './checkout-item.entity';

export enum CheckoutStatus {
  STARTED = 'STARTED',
  RESERVED = 'RESERVED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  ABANDONED = 'ABANDONED',
  EXPIRED = 'EXPIRED'
}

@Entity('checkouts')
export class Checkout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToMany(() => CheckoutItem, (item) => item.checkout, { cascade: true })
  items: CheckoutItem[];

  @Column()
  deliveryPincode: string;

  @Column({ type: 'enum', enum: CheckoutStatus, default: CheckoutStatus.STARTED })
  status: CheckoutStatus;

  @Column({ unique: true })
  idempotencyKey: string;

  @Column()
  requestPayloadHash: string;

  @Column({ type: 'timestamp', nullable: true })
  retryDeadlineAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
