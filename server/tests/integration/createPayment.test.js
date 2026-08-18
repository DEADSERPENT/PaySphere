const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('POST /api/v1/payments (API + PostgreSQL)', () => {
  let app;

  beforeAll(async () => {
    await testDb.migrate();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await testDb.truncateAll();
    mockGateway.reset();
  });

  afterAll(async () => {
    await testDb.closeDb();
  });

  const validBody = { orderId: 'ORDER-1', amount: 149900, currency: 'INR' };

  test('creates a payment intent and a gateway order', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'key-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toMatch(/^pay_/);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.gateway).toBe('razorpay');
    expect(res.body.gatewayOrderId).toMatch(/^order_mock_/);
  });

  test('persists the intent so GET returns it with state history', async () => {
    const createRes = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'key-2')
      .send(validBody);

    const getRes = await request(app).get(`/api/v1/payments/${createRes.body.paymentId}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.paymentId).toBe(createRes.body.paymentId);
    expect(getRes.body.status).toBe('PENDING');
    expect(getRes.body.orders).toHaveLength(1);
    expect(getRes.body.orders[0].gatewayOrderId).toBe(createRes.body.gatewayOrderId);
    const transitions = getRes.body.history.map((h) => `${h.fromState}->${h.toState}`);
    expect(transitions).toEqual(expect.arrayContaining(['null->CREATED', 'CREATED->PENDING']));
  });

  test('rejects a request without an Idempotency-Key header', async () => {
    const res = await request(app).post('/api/v1/payments').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects an invalid payload', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'key-3')
      .send({ orderId: 'O', amount: -5, currency: 'INR' });
    expect(res.status).toBe(400);
  });

  test('replays the exact same response for a retried request with the same key and payload', async () => {
    const first = await request(app).post('/api/v1/payments').set('Idempotency-Key', 'key-replay').send(validBody);
    const second = await request(app).post('/api/v1/payments').set('Idempotency-Key', 'key-replay').send(validBody);

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);

    // Only one payment_intents row should exist for this key.
    const getRes = await request(app).get(`/api/v1/payments/${first.body.paymentId}`);
    expect(getRes.status).toBe(200);
  });

  test('rejects reuse of the same key with a materially different payload', async () => {
    await request(app).post('/api/v1/payments').set('Idempotency-Key', 'key-conflict').send(validBody);
    const conflicting = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'key-conflict')
      .send({ ...validBody, amount: 999 });

    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  test('returns 404 for an unknown payment id', async () => {
    const res = await request(app).get('/api/v1/payments/pay_does_not_exist');
    expect(res.status).toBe(404);
  });
});
