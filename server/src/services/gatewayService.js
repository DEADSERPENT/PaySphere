const env = require('../config/env');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const { retryWithBackoff } = require('../lib/retry');
const { RazorpayAdapter } = require('./razorpayAdapter');
const { MockGatewayAdapter } = require('./mockGatewayAdapter');

function buildAdapter() {
  if (env.gatewayAdapter === 'mock') {
    logger.warn({}, 'Using in-memory mock gateway adapter (GATEWAY_ADAPTER=mock)');
    return new MockGatewayAdapter();
  }
  return new RazorpayAdapter();
}

const adapter = buildAdapter();

async function instrumented(operation, fn, { retryable = true } = {}) {
  const start = Date.now();
  try {
    const result = retryable
      ? await retryWithBackoff(() => fn(), { operation: `gateway.${operation}` })
      : await fn();
    metrics.gatewayLatency(operation, Date.now() - start);
    return result;
  } catch (err) {
    metrics.gatewayLatency(operation, Date.now() - start);
    logger.error({ operation, err: err.message }, 'Gateway operation failed');
    throw err;
  }
}

module.exports = {
  gateway: adapter,
  name: adapter.name,

  createOrder: (params) => instrumented('createOrder', () => adapter.createOrder(params)),
  fetchOrder: (gatewayOrderId) => instrumented('fetchOrder', () => adapter.fetchOrder(gatewayOrderId)),
  fetchPayment: (gatewayPaymentId) =>
    instrumented('fetchPayment', () => adapter.fetchPayment(gatewayPaymentId)),
  fetchPaymentsForOrder: (gatewayOrderId) =>
    instrumented('fetchPaymentsForOrder', () => adapter.fetchPaymentsForOrder(gatewayOrderId)),
  verifyPaymentSignature: (params) => adapter.verifyPaymentSignature(params),
  verifyWebhookSignature: (params) => adapter.verifyWebhookSignature(params),
  refund: (gatewayPaymentId, amount) =>
    instrumented('refund', () => adapter.refund(gatewayPaymentId, amount), { retryable: false }),
};
