const request = require('supertest');
const db = require('../../src/config/database');
const idempotencyRepository = require('../../src/repositories/idempotencyRepository');
const { hashRequest } = require('../../src/middleware/idempotency');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('failure injection: crashed request leaves an abandoned in-progress idempotency claim', () => {
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

  test('a retry cannot claim the key while the original claim is still fresh', async () => {
    const body = { orderId: 'ORDER-STALE-1', amount: 12000, currency: 'INR' };
    await idempotencyRepository.claim(null, {
      id: 'idem_abandoned_fresh',
      scope: 'create_payment',
      idempotencyKey: 'stale-key-fresh',
      requestHash: hashRequest(body),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app).post('/api/v1/payments').set('Idempotency-Key', 'stale-key-fresh').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  });

  test('a retry reclaims and succeeds once the original claim is older than the in-flight timeout', async () => {
    const body = { orderId: 'ORDER-STALE-2', amount: 12000, currency: 'INR' };
    await idempotencyRepository.claim(null, {
      id: 'idem_abandoned_stale',
      scope: 'create_payment',
      idempotencyKey: 'stale-key-old',
      requestHash: hashRequest(body),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    // Simulate the claimant having crashed a while ago: backdate created_at
    // well past IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS.
    await db.query(`UPDATE idempotency_records SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      'idem_abandoned_stale',
    ]);

    const res = await request(app).post('/api/v1/payments').set('Idempotency-Key', 'stale-key-old').send(body);

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toMatch(/^pay_/);
  });

  test('a genuinely concurrent retry against a just-reclaimed key is rejected, not double-processed', async () => {
    const body = { orderId: 'ORDER-STALE-3', amount: 12000, currency: 'INR' };
    await idempotencyRepository.claim(null, {
      id: 'idem_abandoned_race',
      scope: 'create_payment',
      idempotencyKey: 'stale-key-race',
      requestHash: hashRequest(body),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await db.query(`UPDATE idempotency_records SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      'idem_abandoned_race',
    ]);

    const send = () => request(app).post('/api/v1/payments').set('Idempotency-Key', 'stale-key-race').send(body);
    const [first, second] = await Promise.all([send(), send()]);

    const statuses = [first.status, second.status].sort();
    // Exactly one reclaims and succeeds; the other observes it as in-progress again.
    expect(statuses).toEqual([201, 409]);
  });
});
