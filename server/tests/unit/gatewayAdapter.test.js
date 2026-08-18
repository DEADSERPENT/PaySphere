const { MockGatewayAdapter } = require('../../src/services/mockGatewayAdapter');

describe('gateway adapter (mock, exercising the same contract as Razorpay)', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MockGatewayAdapter({ keySecret: 'test_key_secret', webhookSecret: 'test_webhook_secret' });
  });

  test('createOrder returns a gateway order id and CREATED-ish status', async () => {
    const order = await adapter.createOrder({ amount: 1000, currency: 'INR', receipt: 'ORDER-1' });
    expect(order.gatewayOrderId).toMatch(/^order_mock_/);
    expect(order.status).toBe('created');
  });

  test('fetchOrder throws a 404-shaped error for an unknown order', async () => {
    await expect(adapter.fetchOrder('order_missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('fetchPayment throws a 404-shaped error for an unknown payment', async () => {
    await expect(adapter.fetchPayment('pay_missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('simulatePaymentCaptured is reflected in fetchPayment as CAPTURED', async () => {
    const order = await adapter.createOrder({ amount: 1000, currency: 'INR', receipt: 'ORDER-1' });
    const payment = adapter.simulatePaymentCaptured(order.gatewayOrderId);
    const fetched = await adapter.fetchPayment(payment.id);
    expect(fetched.status).toBe('CAPTURED');
    expect(fetched.amount).toBe(1000);
  });

  test('simulatePaymentFailed is reflected in fetchPayment as FAILED with a reason', async () => {
    const order = await adapter.createOrder({ amount: 1000, currency: 'INR', receipt: 'ORDER-1' });
    const payment = adapter.simulatePaymentFailed(order.gatewayOrderId, { error_description: 'Card declined' });
    const fetched = await adapter.fetchPayment(payment.id);
    expect(fetched.status).toBe('FAILED');
    expect(fetched.failureReason).toBe('Card declined');
  });

  test('fetchPaymentsForOrder lists every attempt against an order', async () => {
    const order = await adapter.createOrder({ amount: 1000, currency: 'INR', receipt: 'ORDER-1' });
    adapter.simulatePaymentFailed(order.gatewayOrderId);
    adapter.simulatePaymentCaptured(order.gatewayOrderId);
    const payments = await adapter.fetchPaymentsForOrder(order.gatewayOrderId);
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.status).sort()).toEqual(['CAPTURED', 'FAILED']);
  });

  describe('verifyPaymentSignature', () => {
    test('accepts a correctly signed checkout response', () => {
      const signature = adapter.signCheckout('order_1', 'pay_1');
      expect(adapter.verifyPaymentSignature({ gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature })).toBe(
        true
      );
    });

    test('rejects a tampered signature', () => {
      const signature = adapter.signCheckout('order_1', 'pay_1');
      expect(
        adapter.verifyPaymentSignature({ gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_2', signature })
      ).toBe(false);
    });

    test('rejects a signature produced with a different secret', () => {
      const other = new MockGatewayAdapter({ keySecret: 'wrong_secret', webhookSecret: 'wrong' });
      const signature = other.signCheckout('order_1', 'pay_1');
      expect(adapter.verifyPaymentSignature({ gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature })).toBe(
        false
      );
    });
  });

  describe('verifyWebhookSignature', () => {
    test('accepts a correctly signed body', () => {
      const rawBody = JSON.stringify({ event: 'payment.captured' });
      const signature = adapter.signWebhookBody(rawBody);
      expect(adapter.verifyWebhookSignature({ rawBody, signature })).toBe(true);
    });

    test('rejects a body that does not match the signature', () => {
      const signature = adapter.signWebhookBody(JSON.stringify({ event: 'payment.captured' }));
      const tamperedBody = JSON.stringify({ event: 'payment.failed' });
      expect(adapter.verifyWebhookSignature({ rawBody: tamperedBody, signature })).toBe(false);
    });

    test('rejects a missing signature', () => {
      expect(adapter.verifyWebhookSignature({ rawBody: '{}', signature: undefined })).toBe(false);
    });
  });

  test('refund is not yet implemented', async () => {
    await expect(adapter.refund('pay_1', 100)).rejects.toMatchObject({ name: 'NotImplementedError' });
  });
});
