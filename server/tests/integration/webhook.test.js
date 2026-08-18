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

describe('POST /api/v1/webhooks/razorpay (webhook + PostgreSQL)', () => {
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
      .send({ orderId: 'ORDER-WH', amount: 25000, currency: 'INR' });
    return res.body;
  }

  test('applies a payment.captured event and settles the payment', async () => {
    const created = await createPayment('wh-key-1');
    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);
    const event = mockGateway.buildWebhookEventPayload('payment.captured', payment, 'evt_1');

    const res = await sendWebhook(app, event);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
    expect(getRes.body.transactions).toHaveLength(1);
  });

  test('rejects a webhook with an invalid signature before mutating state', async () => {
    const created = await createPayment('wh-key-2');
    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);
    const event = mockGateway.buildWebhookEventPayload('payment.captured', payment, 'evt_2');
    const rawBody = JSON.stringify(event);

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'forged-signature')
      .send(rawBody);

    expect(res.status).toBe(401);

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });

  test('duplicate delivery of the same event is harmless: no second transaction is created', async () => {
    const created = await createPayment('wh-key-3');
    const payment = mockGateway.simulatePaymentCaptured(created.gatewayOrderId);
    const event = mockGateway.buildWebhookEventPayload('payment.captured', payment, 'evt_3');

    const first = await sendWebhook(app, event);
    const second = await sendWebhook(app, event);

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('PROCESSED');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('DUPLICATE');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.transactions).toHaveLength(1);
  });

  test('an unrecognized event type is acknowledged but does not change payment state', async () => {
    const created = await createPayment('wh-key-4');
    const event = { id: 'evt_4', event: 'refund.created', payload: {} };

    const res = await sendWebhook(app, event);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });

  test('a webhook for an unknown gateway order is acknowledged and ignored', async () => {
    const event = {
      id: 'evt_5',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_orphan', order_id: 'order_mock_unknown', amount: 1000, currency: 'INR', status: 'captured' },
        },
      },
    };

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
  });
});
