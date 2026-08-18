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

describe('failure injection: two workers race on the same webhook event', () => {
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

  test('concurrent identical webhook deliveries produce exactly one processed outcome and one transaction', async () => {
    const created = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'race-key-1')
      .send({ orderId: 'ORDER-RACE-1', amount: 30000, currency: 'INR' });

    const payment = mockGateway.simulatePaymentCaptured(created.body.gatewayOrderId);
    const event = mockGateway.buildWebhookEventPayload('payment.captured', payment, 'evt_race_1');

    const [first, second] = await Promise.all([sendWebhook(app, event), sendWebhook(app, event)]);

    const statuses = [first.body.status, second.body.status].sort();
    expect(statuses).toEqual(['DUPLICATE', 'PROCESSED']);

    const getRes = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
    expect(getRes.body.transactions).toHaveLength(1);
  });
});
