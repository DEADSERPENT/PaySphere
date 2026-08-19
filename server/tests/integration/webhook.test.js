const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const testDb = require('../helpers/testDb');

function sendWebhook(app, event, { signature } = {}) {
  const rawBody = JSON.stringify(event.body);
  const sig = signature !== undefined ? signature : mockGateway.signWebhookBody(rawBody);
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', sig)
    .set('x-razorpay-event-id', event.eventId)
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

    const res = await sendWebhook(app, event, { signature: 'forged-signature' });

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

  test('payment.authorized followed by payment.captured for the same attempt settles the payment without crashing', async () => {
    const created = await createPayment('wh-key-authorize-then-capture');
    const captured = mockGateway.simulatePaymentCaptured(created.gatewayOrderId, { id: 'pay_authcap_1' });
    const authorized = { ...captured, status: 'authorized' };

    const authorizedEvent = mockGateway.buildWebhookEventPayload('payment.authorized', authorized, 'evt_authorized_1');
    const capturedEvent = mockGateway.buildWebhookEventPayload('payment.captured', captured, 'evt_captured_1');

    const authorizedRes = await sendWebhook(app, authorizedEvent);
    expect(authorizedRes.status).toBe(200);
    expect(authorizedRes.body.status).toBe('PROCESSED');

    let getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PROCESSING');
    expect(getRes.body.attempts).toHaveLength(1);

    const capturedRes = await sendWebhook(app, capturedEvent);
    expect(capturedRes.status).toBe(200);
    expect(capturedRes.body.status).toBe('PROCESSED');

    getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
    expect(getRes.body.transactions).toHaveLength(1);
    // Same underlying gatewayPaymentId across both events -- one attempt
    // row, updated in place, not a second row (uq_payment_attempts_gateway_payment_id).
    expect(getRes.body.attempts).toHaveLength(1);
    expect(getRes.body.attempts[0].status).toBe('SUCCEEDED');
  });

  test('an unrecognized event type is acknowledged but does not change payment state', async () => {
    const created = await createPayment('wh-key-4');
    const event = { body: { event: 'refund.created', payload: {} }, eventId: 'evt_4' };

    const res = await sendWebhook(app, event);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');

    const getRes = await request(app).get(`/api/v1/payments/${created.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');
  });

  test('a webhook for an unknown gateway order is acknowledged and ignored', async () => {
    const event = {
      body: {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_orphan',
              order_id: 'order_mock_unknown',
              amount: 1000,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      },
      eventId: 'evt_5',
    };

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
  });
});
