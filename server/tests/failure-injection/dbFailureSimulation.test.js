const request = require('supertest');
const db = require('../../src/config/database');
const paymentRepository = require('../../src/repositories/paymentRepository');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('failure injection: database failure mid-transaction', () => {
  let app;

  beforeAll(async () => {
    await testDb.migrate();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await testDb.truncateAll();
    mockGateway.reset();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await testDb.closeDb();
  });

  test('a write failure partway through intent creation rolls back cleanly and leaves no partial row', async () => {
    jest.spyOn(paymentRepository, 'insertStateHistory').mockImplementationOnce(() => {
      throw new Error('Simulated database failure');
    });

    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'db-fail-key-1')
      .send({ orderId: 'ORDER-DBFAIL-1', amount: 15000, currency: 'INR' });

    expect(res.status).toBe(500);

    const { rows } = await db.query('SELECT * FROM payment_intents WHERE external_order_id = $1', [
      'ORDER-DBFAIL-1',
    ]);
    expect(rows).toHaveLength(0);
  });

  test('the idempotency key is released after a failed write, so a retry can succeed', async () => {
    jest.spyOn(paymentRepository, 'insertStateHistory').mockImplementationOnce(() => {
      throw new Error('Simulated database failure');
    });

    const first = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'db-fail-key-2')
      .send({ orderId: 'ORDER-DBFAIL-2', amount: 15000, currency: 'INR' });
    expect(first.status).toBe(500);

    const retry = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'db-fail-key-2')
      .send({ orderId: 'ORDER-DBFAIL-2', amount: 15000, currency: 'INR' });
    expect(retry.status).toBe(201);
  });
});
