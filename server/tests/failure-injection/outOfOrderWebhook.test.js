const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

function sendWebhook(app, eventPayload) {
  const rawBody = JSON.stringify(eventPayload);
  const signature = mockGateway.signWebhookBody(rawBody);
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .send(rawBody);
}

describe('failure injection: out-of-order webhook delivery', () => {
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

  test('a stale failed-attempt event arriving after a later captured event is ignored, not reverted', async () => {
    const created = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'ooo-key-1')
      .send({ orderId: 'ORDER-OOO-1', amount: 20000, currency: 'INR' });

    // Attempt 1 failed, attempt 2 (a retry by the customer) succeeded. The
    // captured webhook for attempt 2 is delivered first...
    const failedPayment = mockGateway.simulatePaymentFailed(created.body.gatewayOrderId, { id: 'pay_attempt_1' });
    const capturedPayment = mockGateway.simulatePaymentCaptured(created.body.gatewayOrderId, { id: 'pay_attempt_2' });

    const capturedEvent = mockGateway.buildWebhookEventPayload('payment.captured', capturedPayment, 'evt_ooo_captured');
    const failedEvent = mockGateway.buildWebhookEventPayload('payment.failed', failedPayment, 'evt_ooo_failed');

    const capturedRes = await sendWebhook(app, capturedEvent);
    expect(capturedRes.status).toBe(200);

    let getRes = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');

    // ...then the stale failed webhook for attempt 1 arrives late.
    const failedRes = await sendWebhook(app, failedEvent);
    expect(failedRes.status).toBe(200);
    expect(failedRes.body.status).toBe('PROCESSED');

    getRes = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
    expect(getRes.body.transactions).toHaveLength(1);
  });
});
