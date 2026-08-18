const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('POST /api/v1/payments/:id/verify', () => {
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

  async function createPayment(key, body = { orderId: 'ORDER-VERIFY', amount: 50000, currency: 'INR' }) {
    const res = await request(app).post('/api/v1/payments').set('Idempotency-Key', key).send(body);
    return res.body;
  }

  test('server-side verifies a captured payment and settles it to COMPLETED', async () => {
    const created = await createPayment('verify-key-1');
    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);
    const signature = mockGateway.signCheckout(created.gatewayOrderId, payment.id);

    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/verify`).send({
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: payment.id,
      signature,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.transactions).toHaveLength(1);
    expect(getRes.body.transactions[0].gatewayPaymentId).toBe(payment.id);
  });

  test('server-side verifies a failed payment and marks it FAILED', async () => {
    const created = await createPayment('verify-key-2');
    const payment = mockGateway.simulatePaymentFailed(created.gatewayOrderId, { error_description: 'Insufficient funds' });
    const signature = mockGateway.signCheckout(created.gatewayOrderId, payment.id);

    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/verify`).send({
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: payment.id,
      signature,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED');
  });

  test('rejects an invalid signature without mutating payment state', async () => {
    const created = await createPayment('verify-key-3');
    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);

    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/verify`).send({
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: payment.id,
      signature: 'not-a-real-signature',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VERIFICATION_FAILED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });

  test('never trusts a client-asserted success without a matching gateway payment', async () => {
    const created = await createPayment('verify-key-4');
    // Client claims success for a payment ID that was never recorded at the gateway.
    const forgedSignature = mockGateway.signCheckout(created.gatewayOrderId, 'pay_forged');

    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/verify`).send({
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: 'pay_forged',
      signature: forgedSignature,
    });

    // Signature "checks out" cryptographically for the forged pair, but the
    // authoritative gateway fetch for pay_forged fails -- state must not change.
    expect(res.status).toBe(500);
    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });
});
