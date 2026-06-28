import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique, ManyToOne, JoinColumn, Check } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { Location } from '../../locations/entities/location.entity';

@Entity('inventory')
@Unique(['productId', 'locationId'])
// This CHECK constraint acts as a backstop database guarantee.
// The primary concurrency control for reservations comes from the 
// 'SELECT ... FOR UPDATE' row-level lock during the checkout transaction.
@Check(`"stock" >= "reserved"`)
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  productId: string;

  @Column('uuid')
  locationId: string;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'int', default: 0 })
  reserved: number;

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'productId' })
  product: Product;

  @ManyToOne(() => Location)
  @JoinColumn({ name: 'locationId' })
  location: Location;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
