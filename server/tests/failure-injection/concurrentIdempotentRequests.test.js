const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('failure injection: concurrent retries of the same idempotent create-payment request', () => {
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

  test('never creates two payment intents for the same idempotency key under concurrency', async () => {
    const body = { orderId: 'ORDER-CONCURRENT-1', amount: 42000, currency: 'INR' };
    const send = () => request(app).post('/api/v1/payments').set('Idempotency-Key', 'concurrent-key-1').send(body);

    const responses = await Promise.all([send(), send(), send(), send(), send()]);

    for (const res of responses) {
      expect([201, 409]).toContain(res.status);
    }

    const successes = responses.filter((r) => r.status === 201);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const distinctPaymentIds = new Set(successes.map((r) => r.body.paymentId));
    expect(distinctPaymentIds.size).toBe(1);

    for (const res of responses.filter((r) => r.status === 409)) {
      expect(res.body.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    }
  });
});
