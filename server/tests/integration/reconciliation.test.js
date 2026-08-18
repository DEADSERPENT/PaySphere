const request = require('supertest');
const db = require('../../src/config/database');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const reconciliationService = require('../../src/services/reconciliationService');
const testDb = require('../helpers/testDb');

async function backdateUpdatedAt(paymentId, minutesAgo) {
  await db.query(`UPDATE payment_intents SET updated_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [
    paymentId,
    minutesAgo,
  ]);
}

describe('reconciliation service', () => {
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

  async function createStuckPayment(key) {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', key)
      .send({ orderId: 'ORDER-RECON', amount: 10000, currency: 'INR' });
    await backdateUpdatedAt(res.body.paymentId, 60);
    return res.body;
  }

  test('expires a payment with no gateway attempt after the timeout', async () => {
    const created = await createStuckPayment('recon-key-1');

    const { results } = await reconciliationService.runReconciliationSweep();

    expect(results).toContainEqual(expect.objectContaining({ paymentIntentId: created.paymentId, outcome: 'EXPIRED' }));
    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('EXPIRED');
  });

  test('finalizes a payment the gateway reports as captured but PaySphere never heard about', async () => {
    const created = await createStuckPayment('recon-key-2');
    mockGateway.simulatePaymentCaptured(created.gatewayOrderId);

    const { results } = await reconciliationService.runReconciliationSweep();

    expect(results).toContainEqual(expect.objectContaining({ paymentIntentId: created.paymentId, outcome: 'SUCCESS' }));
    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
    expect(getRes.body.transactions).toHaveLength(1);
  });

  test('fails a payment the gateway reports as failed', async () => {
    const created = await createStuckPayment('recon-key-3');
    mockGateway.simulatePaymentFailed(created.gatewayOrderId);

    const { results } = await reconciliationService.runReconciliationSweep();

    expect(results).toContainEqual(expect.objectContaining({ paymentIntentId: created.paymentId, outcome: 'FAILED' }));
    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('FAILED');
  });

  test('leaves an ambiguous in-flight authorization untouched for the next pass', async () => {
    const created = await createStuckPayment('recon-key-4');
    mockGateway.simulatePaymentCaptured(created.gatewayOrderId, { status: 'authorized' });

    const { results } = await reconciliationService.runReconciliationSweep();

    expect(results).toContainEqual(expect.objectContaining({ paymentIntentId: created.paymentId, outcome: 'UNKNOWN' }));
    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });

  test('does not touch payments that are not yet stuck', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'recon-key-5')
      .send({ orderId: 'ORDER-FRESH', amount: 10000, currency: 'INR' });

    const { scanned } = await reconciliationService.runReconciliationSweep();
    expect(scanned).toBe(0);

    const getRes = await request(app).get(`/api/v1/payments/${res.body.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });
});
