const request = require('supertest');
const { buildTestApp, mockGateway } = require('../helpers/testApp');
const paymentService = require('../../src/services/paymentService');
const webhookService = require('../../src/services/webhookService');
const webhookRepository = require('../../src/repositories/webhookRepository');
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

describe('failure injection: worker crash mid webhook-processing', () => {
  let app;

  beforeAll(async () => {
    await testDb.migrate();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await testDb.truncateAll();
    mockGateway.reset();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await testDb.closeDb();
  });

  test('a crash after persisting but before applying leaves the event durably retryable, and retry recovers', async () => {
    const created = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'crash-key-1')
      .send({ orderId: 'ORDER-CRASH-1', amount: 18000, currency: 'INR' });

    const payment = mockGateway.simulatePaymentCaptured(created.body.gatewayOrderId);
    const event = mockGateway.buildWebhookEventPayload('payment.captured', payment, 'evt_crash_1');

    const crashSpy = jest
      .spyOn(paymentService, 'applyGatewayOutcome')
      .mockImplementationOnce(() => {
        throw new Error('Simulated worker crash mid-processing');
      });

    const crashedRes = await sendWebhook(app, event);
    expect(crashedRes.status).toBe(500);
    crashSpy.mockRestore();

    // The event survived the crash in a retryable state; the payment itself is untouched.
    let getRes = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('PENDING');

    const pending = await webhookRepository.findPendingForRetry(null, 50);
    const persisted = pending.find((e) => e.gateway_event_id === 'evt_crash_1');
    expect(persisted).toBeTruthy();
    expect(persisted.status).toBe('FAILED');

    // A retry worker picks the persisted event back up and reprocesses it.
    await webhookService.processEvent(persisted);
    await webhookRepository.markProcessed(null, persisted.id);

    getRes = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('COMPLETED');
  });
});
