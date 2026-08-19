const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('failure injection: gateway timeout during order creation', () => {
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

  test('a transient timeout that clears within the retry budget still succeeds', async () => {
    const timeoutErr = Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' });
    mockGateway.setCreateOrderFailure(timeoutErr, 2); // fails twice, succeeds on the 3rd (final) attempt

    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'timeout-key-1')
      .send({ orderId: 'ORDER-TIMEOUT-1', amount: 10000, currency: 'INR' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
  });

  test('a persistent gateway outage fails the payment intent instead of leaving it stuck PENDING', async () => {
    const timeoutErr = Object.assign(new Error('gateway unreachable'), { code: 'ETIMEDOUT' });
    mockGateway.setCreateOrderFailure(timeoutErr, Infinity);

    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'timeout-key-2')
      .send({ orderId: 'ORDER-TIMEOUT-2', amount: 10000, currency: 'INR' });

    expect(res.status).toBeGreaterThanOrEqual(500);

    // The idempotency claim must have been released so a retry with the
    // same key is possible once the gateway recovers.
    mockGateway.reset();
    const retryRes = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'timeout-key-2')
      .send({ orderId: 'ORDER-TIMEOUT-2', amount: 10000, currency: 'INR' });
    expect(retryRes.status).toBe(201);
  });

  test('a permanent (4xx) gateway rejection is not retried and surfaces the original status', async () => {
    const badRequestErr = Object.assign(new Error('invalid request'), { statusCode: 400 });
    mockGateway.setCreateOrderFailure(badRequestErr, Infinity);

    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'timeout-key-3')
      .send({ orderId: 'ORDER-TIMEOUT-3', amount: 10000, currency: 'INR' });

    expect(res.status).toBe(400);
  });

  test('a gateway auth failure (invalid/revoked API keys) surfaces as 401, not a generic 500', async () => {
    const authErr = Object.assign(new Error('Authentication failed'), { statusCode: 401 });
    mockGateway.setCreateOrderFailure(authErr, Infinity);

    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'timeout-key-4')
      .send({ orderId: 'ORDER-TIMEOUT-4', amount: 10000, currency: 'INR' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GATEWAY_AUTH_FAILED');
  });
});
