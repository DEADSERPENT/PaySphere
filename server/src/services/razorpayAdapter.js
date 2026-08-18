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
    const order = await this.client.orders.create({
      amount,
      currency,
      receipt,
      notes,
    });
    return {
      gatewayOrderId: order.id,
      status: order.status,
      raw: order,
    };
  }

  async fetchOrder(gatewayOrderId) {
    const order = await this.client.orders.fetch(gatewayOrderId);
    return {
      gatewayOrderId: order.id,
      status: order.status,
      amountPaid: order.amount_paid,
      raw: order,
    };
  }

  /** Lists every payment attempt Razorpay has recorded against an order — the reconciliation service's view into gateway-side truth. */
  async fetchPaymentsForOrder(gatewayOrderId) {
    const { items } = await this.client.orders.fetchPayments(gatewayOrderId);
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
    const payment = await this.client.payments.fetch(gatewayPaymentId);
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
