const crypto = require('node:crypto');
const Razorpay = require('razorpay');
const env = require('../config/env');
const { NotImplementedError } = require('./gatewayAdapter.interface');

const RAZORPAY_TO_INTERNAL_PAYMENT_STATUS = {
  created: 'CREATED',
  authorized: 'AUTHORIZED',
  captured: 'CAPTURED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
};

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The `razorpay` SDK rejects with a plain `{ statusCode, error: { code,
 * description } }` object, not an Error instance -- so `.message` is
 * `undefined` everywhere downstream (logs, retry classification, API error
 * responses all go silent). Wrapping every SDK call through this normalizes
 * that into a real Error with the actual Razorpay-provided description, so
 * "gateway isolation" (spec section 8.3) also covers not leaking the SDK's
 * error shape past this file.
 */
async function callRazorpay(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error) throw err;
    const description = (err && err.error && (err.error.description || err.error.code)) || 'Razorpay API error';
    const normalized = new Error(description);
    normalized.statusCode = err && err.statusCode;
    normalized.code = err && err.error && err.error.code;
    normalized.cause = err;
    throw normalized;
  }
}

/**
 * Razorpay-specific implementation of the gateway adapter interface (spec
 * section 8.3). All Razorpay SDK/API knowledge is contained in this file;
 * nothing outside it should import the `razorpay` package directly.
 */
class RazorpayAdapter {
  constructor(config = env.razorpay) {
    this.name = 'razorpay';
    this.config = config;
    this.client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
  }

  async createOrder({ amount, currency, receipt, notes }) {
    const order = await callRazorpay(() => this.client.orders.create({ amount, currency, receipt, notes }));
    return {
      gatewayOrderId: order.id,
      status: order.status,
      raw: order,
    };
  }

  async fetchOrder(gatewayOrderId) {
    const order = await callRazorpay(() => this.client.orders.fetch(gatewayOrderId));
    return {
      gatewayOrderId: order.id,
      status: order.status,
      amountPaid: order.amount_paid,
      raw: order,
    };
  }

  /** Lists every payment attempt Razorpay has recorded against an order — the reconciliation service's view into gateway-side truth. */
  async fetchPaymentsForOrder(gatewayOrderId) {
    const { items } = await callRazorpay(() => this.client.orders.fetchPayments(gatewayOrderId));
    return items.map((payment) => ({
      gatewayPaymentId: payment.id,
      gatewayOrderId: payment.order_id,
      status: RAZORPAY_TO_INTERNAL_PAYMENT_STATUS[payment.status] || payment.status.toUpperCase(),
      amount: payment.amount,
      currency: payment.currency,
      failureCode: payment.error_code || null,
      failureReason: payment.error_description || null,
      raw: payment,
    }));
  }

  async fetchPayment(gatewayPaymentId) {
    const payment = await callRazorpay(() => this.client.payments.fetch(gatewayPaymentId));
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

  /**
   * Verifies the checkout-flow signature Razorpay returns to the browser
   * client. This is the local cryptographic check only — callers must still
   * treat the result as advisory and fetch the payment from the gateway for
   * the authoritative status (spec section 10.3, invariant in section 7).
   */
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
}

module.exports = { RazorpayAdapter, RAZORPAY_TO_INTERNAL_PAYMENT_STATUS };
