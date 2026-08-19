const crypto = require('node:crypto');
const { NotImplementedError } = require('./gatewayAdapter.interface');
const { RAZORPAY_TO_INTERNAL_PAYMENT_STATUS } = require('./razorpayAdapter');

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}_mock_${Date.now()}_${counter}`;
}

/**
 * In-memory gateway adapter implementing the same interface as
 * RazorpayAdapter (spec section 8.3), used for local development
 * (GATEWAY_ADAPTER=mock) and as the deterministic gateway double in the
 * test suite. Tests can reach into `orders`/`payments` or use the
 * simulate* helpers to drive specific gateway outcomes (success, failure,
 * timeout) without any network dependency.
 */
class MockGatewayAdapter {
  constructor(config = { keySecret: 'mock_key_secret', webhookSecret: 'mock_webhook_secret' }) {
    this.name = 'razorpay'; // keep the same gateway label so DB rows are adapter-agnostic
    this.config = config;
    this.orders = new Map();
    this.payments = new Map();
    this._createOrderFailureError = null;
    this._createOrderFailuresRemaining = 0;
  }

  /**
   * Makes the next `times` calls to createOrder throw `error` before
   * succeeding again. times=Infinity simulates a gateway that never
   * recovers; a finite count simulates a transient blip retries can ride out.
   */
  setCreateOrderFailure(error, times = 1) {
    this._createOrderFailureError = error;
    this._createOrderFailuresRemaining = times;
  }

  async createOrder({ amount, currency, receipt, notes }) {
    if (this._createOrderFailuresRemaining > 0) {
      this._createOrderFailuresRemaining -= 1;
      throw this._createOrderFailureError;
    }
    const id = nextId('order');
    const order = { id, amount, currency, receipt, notes, status: 'created', amount_paid: 0 };
    this.orders.set(id, order);
    return { gatewayOrderId: id, status: order.status, raw: order };
  }

  async fetchOrder(gatewayOrderId) {
    const order = this.orders.get(gatewayOrderId);
    if (!order) {
      const err = new Error(`Order not found: ${gatewayOrderId}`);
      err.statusCode = 404;
      throw err;
    }
    return { gatewayOrderId: order.id, status: order.status, amountPaid: order.amount_paid, raw: order };
  }

  async fetchPaymentsForOrder(gatewayOrderId) {
    const items = [];
    for (const payment of this.payments.values()) {
      if (payment.order_id === gatewayOrderId) {
        items.push({
          gatewayPaymentId: payment.id,
          gatewayOrderId: payment.order_id,
          status: RAZORPAY_TO_INTERNAL_PAYMENT_STATUS[payment.status] || payment.status.toUpperCase(),
          amount: payment.amount,
          currency: payment.currency,
          failureCode: payment.error_code || null,
          failureReason: payment.error_description || null,
          raw: payment,
        });
      }
    }
    return items;
  }

  async fetchPayment(gatewayPaymentId) {
    const payment = this.payments.get(gatewayPaymentId);
    if (!payment) {
      const err = new Error(`Payment not found: ${gatewayPaymentId}`);
      err.statusCode = 404;
      throw err;
    }
    return {
      gatewayPaymentId: payment.id,
      gatewayOrderId: payment.order_id,
      status: RAZORPAY_TO_INTERNAL_PAYMENT_STATUS[payment.status] || payment.status.toUpperCase(),
      amount: payment.amount,
      currency: payment.currency,
      failureCode: payment.error_code || null,
      failureReason: payment.error_description || null,
      raw: payment,
    };
  }

  verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature }) {
    const expected = crypto
      .createHmac('sha256', this.config.keySecret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest('hex');
    return safeCompare(expected, signature);
  }

  verifyWebhookSignature({ rawBody, signature }) {
    if (!signature) return false;
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');
    return safeCompare(expected, signature);
  }

  async refund() {
    throw new NotImplementedError('refund');
  }

  // ---- Test/dev helpers below: not part of the gateway adapter interface ----

  /** Computes the checkout-signature a real Razorpay client-side SDK would return. */
  signCheckout(gatewayOrderId, gatewayPaymentId) {
    return crypto
      .createHmac('sha256', this.config.keySecret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest('hex');
  }

  /** Computes the X-Razorpay-Signature header value for a raw webhook body. */
  signWebhookBody(rawBody) {
    return crypto.createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
  }

  /** Simulates a successful authorization+capture against an existing order. */
  simulatePaymentCaptured(gatewayOrderId, overrides = {}) {
    const order = this.orders.get(gatewayOrderId);
    if (!order) throw new Error(`Unknown mock order: ${gatewayOrderId}`);
    const id = overrides.id || nextId('pay');
    const payment = {
      id,
      order_id: gatewayOrderId,
      amount: order.amount,
      currency: order.currency,
      status: 'captured',
      ...overrides,
    };
    this.payments.set(id, payment);
    order.status = 'paid';
    order.amount_paid = order.amount;
    return payment;
  }

  /** Simulates a failed payment attempt against an existing order. */
  simulatePaymentFailed(gatewayOrderId, overrides = {}) {
    const order = this.orders.get(gatewayOrderId);
    if (!order) throw new Error(`Unknown mock order: ${gatewayOrderId}`);
    const id = overrides.id || nextId('pay');
    const payment = {
      id,
      order_id: gatewayOrderId,
      amount: order.amount,
      currency: order.currency,
      status: 'failed',
      error_code: overrides.error_code || 'GATEWAY_ERROR',
      error_description: overrides.error_description || 'Simulated payment failure',
      ...overrides,
    };
    this.payments.set(id, payment);
    return payment;
  }

  /**
   * Builds a Razorpay-shaped webhook body + its dedup event ID. Matches the
   * real shape observed from live Razorpay deliveries: the body carries
   * `event` but no unique event ID -- that's delivered separately via the
   * `X-Razorpay-Event-Id` header, which callers must set on the request
   * (see webhookController.js / webhookService.js).
   */
  buildWebhookEventPayload(eventType, payment, eventId = nextId('evt')) {
    return {
      body: {
        entity: 'event',
        event: eventType,
        contains: ['payment'],
        payload: { payment: { entity: payment } },
        created_at: Math.floor(Date.now() / 1000),
      },
      eventId,
    };
  }

  reset() {
    this.orders.clear();
    this.payments.clear();
    this._createOrderFailureError = null;
    this._createOrderFailuresRemaining = 0;
  }
}

module.exports = { MockGatewayAdapter };
