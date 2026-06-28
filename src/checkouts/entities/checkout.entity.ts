import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

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

  @Column('uuid')
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column()
  deliveryPincode: string;

  @Column({ type: 'enum', enum: CheckoutStatus, default: CheckoutStatus.STARTED })
  status: CheckoutStatus;

  @Column('uuid', { nullable: true })
  reservedLocationId: string | null;

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
