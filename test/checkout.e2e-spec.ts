import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';

jest.setTimeout(120000);

describe('Checkout Flow & Concurrency (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5433';
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'postgres';
    process.env.DB_DATABASE = 'inventory_db';
    process.env.RETRY_WINDOW_MINUTES = '15';

    const { AppModule } = require('./../src/app.module');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await dataSource.query(`TRUNCATE TABLE checkout_items, checkouts, inventory, locations, products CASCADE`);
  });

  const createProduct = async (name = 'Test Product', sku = 'TEST-SKU') => {
    const res = await request(app.getHttpServer()).post('/products').send({ name, sku }).expect(201);
    return res.body;
  };

  const createLocation = async (name = 'Warehouse 1', city = 'New York', state = 'NY', servicePincodes = ['10001'], priority = 1) => {
    const res = await request(app.getHttpServer()).post('/locations').send({
      name, city, state, servicePincodes, priority, isActive: true
    }).expect(201);
    return res.body;
  };

  const addInventory = async (productId: string, locationId: string, stock: number) => {
    const res = await request(app.getHttpServer()).post('/inventory').send({ productId, locationId, stock }).expect(201);
    return res.body;
  };

  it('should reserve stock and reduce available stock on successful checkout start', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    const res = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'test-key-1')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    expect(res.body.status).toBe('RESERVED');
    expect(res.body.items).toBeDefined();
    expect(res.body.items[0].reservedLocationId).toBe(location.id);

    // Verify inventory state
    const availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`).expect(200);
    expect(availability.body.totalAvailable).toBe(8);
    expect(availability.body.locations[0].stock).toBe(10);
    expect(availability.body.locations[0].reserved).toBe(2);
  });

  it('Payment success deducts stock and clears reserved stock', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    const checkoutRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'test-key-1')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/checkouts/${checkoutRes.body.id}/payment/success`)
      .expect(201);

    const availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(8);
    expect(availability.body.locations[0].stock).toBe(8); // Reduced physical stock
    expect(availability.body.locations[0].reserved).toBe(0); // Cleared reserved
  });

  it('Payment failure releases reserved stock', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    const checkoutRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'test-key-1')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/checkouts/${checkoutRes.body.id}/payment/failed`)
      .expect(201);

    const availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(10); // Back to full
    expect(availability.body.locations[0].stock).toBe(10); 
    expect(availability.body.locations[0].reserved).toBe(0);
  });

  it('User-dropped payment keeps stock reserved before expiry, then expiry sweep releases it', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    const checkoutRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'test-key-1')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/checkouts/${checkoutRes.body.id}/payment/abandoned`)
      .expect(201);

    let availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(8); 
    expect(availability.body.locations[0].reserved).toBe(2);

    // Run sweep - should not expire because deadline is in the future
    await request(app.getHttpServer()).post('/checkouts/expire').expect(201);
    
    availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(8); 

    // Force deadline to past
    await dataSource.query(`UPDATE checkouts SET "retryDeadlineAt" = NOW() - INTERVAL '1 hour'`);

    // Run sweep again
    await request(app.getHttpServer()).post('/checkouts/expire').expect(201);

    availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(10); 
    expect(availability.body.locations[0].reserved).toBe(0);
  });

  it('Location selection prefers matching pincode over fallback', async () => {
    const product = await createProduct();
    const fallbackLoc = await createLocation('Fallback Loc', 'Los Angeles', 'CA', ['90001'], 2);
    const serviceLoc = await createLocation('Service Loc', 'New York', 'NY', ['10001'], 1);
    
    await addInventory(product.id, fallbackLoc.id, 10);
    await addInventory(product.id, serviceLoc.id, 10);

    const checkoutRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'key-pref')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    expect(checkoutRes.body.items[0].reservedLocationId).toBe(serviceLoc.id);
  });

  it('Fallback selection selects the location with highest priority when no service zone matches', async () => {
    const product = await createProduct();
    
    // Service location that matches pincode but has NO stock
    const outOfStockLoc = await createLocation('No Stock Loc', 'Boston', 'MA', ['02101'], 1);
    await addInventory(product.id, outOfStockLoc.id, 0);

    // Location with priority 2
    const priority2Loc = await createLocation('Priority 2 Loc', 'Seattle', 'WA', ['98101'], 2);
    await addInventory(product.id, priority2Loc.id, 10);

    // Location with priority 3
    const priority3Loc = await createLocation('Priority 3 Loc', 'Cambridge', 'MA', ['02138'], 3);
    await addInventory(product.id, priority3Loc.id, 10);

    const checkoutRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'key-fallback')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '02101' })
      .expect(201);

    expect(checkoutRes.body.items[0].reservedLocationId).toBe(priority2Loc.id);
  });

  it('Idempotent checkout retry returns existing checkout without double reserving', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    const firstRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'idem-key')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    const secondRes = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'idem-key')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    expect(firstRes.body.id).toBe(secondRes.body.id);

    const availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(8);
  });

  it('Same idempotency key with a changed payload is rejected (409)', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await addInventory(product.id, location.id, 10);

    await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'idem-key-2')
      .send({ items: [{ productId: product.id, quantity: 2 }], deliveryPincode: '10001' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'idem-key-2')
      .send({ items: [{ productId: product.id, quantity: 5 }], deliveryPincode: '10001' })
      .expect(409);
  });

  it('Concurrent checkouts cannot reserve more than available stock', async () => {
    const product = await createProduct();
    const location = await createLocation();
    // Only 5 units available
    await addInventory(product.id, location.id, 5);

    // Fire 10 concurrent checkouts trying to reserve 1 unit each.
    // Only 5 should succeed, the rest should fail with 409 (Stock became unavailable).
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        request(app.getHttpServer())
          .post('/checkouts')
          .set('Idempotency-Key', `concurrent-key-${i}`)
          .send({ items: [{ productId: product.id, quantity: 1 }], deliveryPincode: '10001' })
      );
    }

    const results = await Promise.all(promises);
    
    let successCount = 0;
    let conflictCount = 0;

    for (const res of results) {
      if (res.status === 201) successCount++;
      else if (res.status === 409) conflictCount++;
    }

    expect(successCount).toBe(5);
    expect(conflictCount).toBe(5);

    const availability = await request(app.getHttpServer()).get(`/products/${product.id}/availability`);
    expect(availability.body.totalAvailable).toBe(0);
    expect(availability.body.locations[0].reserved).toBe(5);
  });

  it('Multiple products in a single checkout are fulfilled from appropriate locations', async () => {
    const prodA = await createProduct('Product A', 'SKU-A');
    const prodB = await createProduct('Product B', 'SKU-B');
    
    const loc1 = await createLocation('Loc 1', 'NY', 'NY', ['10001'], 1);
    const loc2 = await createLocation('Loc 2', 'NJ', 'NJ', ['10001'], 2);

    // ProdA only in Loc1, ProdB only in Loc2
    await addInventory(prodA.id, loc1.id, 10);
    await addInventory(prodB.id, loc2.id, 10);

    const res = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'multi-product-key')
      .send({ 
        items: [
          { productId: prodA.id, quantity: 2 },
          { productId: prodB.id, quantity: 3 }
        ], 
        deliveryPincode: '10001' 
      })
      .expect(201);

    expect(res.body.items).toHaveLength(2);
    
    const itemA = res.body.items.find((i: any) => i.productId === prodA.id);
    const itemB = res.body.items.find((i: any) => i.productId === prodB.id);

    expect(itemA.reservedLocationId).toBe(loc1.id);
    expect(itemA.quantity).toBe(2);

    expect(itemB.reservedLocationId).toBe(loc2.id);
    expect(itemB.quantity).toBe(3);

    // Verify stock
    const availA = await request(app.getHttpServer()).get(`/products/${prodA.id}/availability`);
    expect(availA.body.totalAvailable).toBe(8);

    const availB = await request(app.getHttpServer()).get(`/products/${prodB.id}/availability`);
    expect(availB.body.totalAvailable).toBe(7);
  });

  it('Splits a single order line across multiple warehouses if one warehouse cannot fulfill it entirely', async () => {
    const product = await createProduct();
    const loc1 = await createLocation('Loc 1', 'NY', 'NY', ['10001'], 1);
    const loc2 = await createLocation('Loc 2', 'LA', 'CA', ['90001'], 2);

    await addInventory(product.id, loc1.id, 50);
    await addInventory(product.id, loc2.id, 50);

    const res = await request(app.getHttpServer())
      .post('/checkouts')
      .set('Idempotency-Key', 'split-order-key')
      .send({ 
        items: [{ productId: product.id, quantity: 100 }], 
        deliveryPincode: '10001' 
      })
      .expect(201);

    expect(res.body.items).toHaveLength(2);
    
    const item1 = res.body.items.find((i: any) => i.reservedLocationId === loc1.id);
    const item2 = res.body.items.find((i: any) => i.reservedLocationId === loc2.id);

    expect(item1.quantity).toBe(50);
    expect(item2.quantity).toBe(50);
  });
});
