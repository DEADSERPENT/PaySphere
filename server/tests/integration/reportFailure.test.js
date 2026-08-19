const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

describe('POST /api/v1/payments/:id/report-failure', () => {
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

  async function createPayment(key) {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', key)
      .send({ orderId: 'ORDER-REPORT', amount: 20000, currency: 'INR' });
    return res.body;
  }

  test('records a client-reported failure as an audit-only attempt without changing payment state', async () => {
    const created = await createPayment('report-key-1');

    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/report-failure`).send({
      code: 'BAD_REQUEST_ERROR',
      description: 'International cards are not supported',
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('RECORDED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING'); // client signal never changes state
    expect(getRes.body.attempts).toHaveLength(1);
    expect(getRes.body.attempts[0]).toMatchObject({
      status: 'CLIENT_REPORTED_FAILURE',
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'International cards are not supported',
    });
  });

  test('accepts a report with no fields at all', async () => {
    const created = await createPayment('report-key-2');
    const res = await request(app).post(`/api/v1/payments/${created.paymentId}/report-failure`).send({});
    expect(res.status).toBe(202);
  });

  test('returns 404 for an unknown payment', async () => {
    const res = await request(app)
      .post('/api/v1/payments/pay_does_not_exist/report-failure')
      .send({ description: 'x' });
    expect(res.status).toBe(404);
  });

  test('a subsequent successful verification still completes normally after a reported failure', async () => {
    const created = await createPayment('report-key-3');
    await request(app).post(`/api/v1/payments/${created.paymentId}/report-failure`).send({
      code: 'GATEWAY_ERROR',
      description: 'Card declined',
    });

    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);
    const signature = mockGateway.signCheckout(created.gatewayOrderId, payment.id);
    const verifyRes = await request(app).post(`/api/v1/payments/${created.paymentId}/verify`).send({
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: payment.id,
      signature,
    });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.status).toBe('COMPLETED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.attempts.map((a) => a.status)).toEqual(
      expect.arrayContaining(['CLIENT_REPORTED_FAILURE', 'SUCCEEDED'])
    );
  });

  test('reporting the same gatewayPaymentId twice does not create duplicate audit rows', async () => {
    const created = await createPayment('report-key-4');
    const body = { code: 'GATEWAY_ERROR', description: 'Card declined', gatewayPaymentId: 'pay_dup_report' };

    await request(app).post(`/api/v1/payments/${created.paymentId}/report-failure`).send(body);
    const second = await request(app).post(`/api/v1/payments/${created.paymentId}/report-failure`).send(body);

    expect(second.status).toBe(202);

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.attempts).toHaveLength(1);
  });
});
