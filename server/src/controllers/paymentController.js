const paymentService = require('../services/paymentService');
const gatewayService = require('../services/gatewayService');
const { asyncHandler } = require('../middleware/errorHandler');

function serializeIntent(intent) {
  return {
    paymentId: intent.id,
    status: intent.status,
    externalOrderId: intent.external_order_id,
    amount: intent.amount,
    currency: intent.currency,
    createdAt: intent.created_at,
    updatedAt: intent.updated_at,
  };
}

const create = asyncHandler(async (req, res) => {
  const { orderId, amount, currency, customerReference, metadata } = req.body;

  let result;
  try {
    result = await paymentService.createPayment({
      externalOrderId: orderId,
      amount,
      currency,
      customerReference,
      metadata: metadata || {},
    });
  } catch (err) {
    await req.idempotency.release();
    throw err;
  }

  const payload = {
    paymentId: result.intent.id,
    status: result.intent.status,
    gateway: result.order.gateway,
    gatewayOrderId: result.order.gateway_order_id,
  };
  await req.idempotency.complete(201, payload);
  res.status(201).json(payload);
});

const get = asyncHandler(async (req, res) => {
  const { intent, orders, transactions, history } = await paymentService.getPayment(req.params.paymentId);
  res.status(200).json({
    ...serializeIntent(intent),
    gateway: gatewayService.name,
    orders: orders.map((o) => ({ gatewayOrderId: o.gateway_order_id, status: o.status })),
    transactions: transactions.map((t) => ({
      transactionId: t.id,
      gatewayPaymentId: t.gateway_payment_id,
      amount: t.amount,
      currency: t.currency,
      status: t.status,
      createdAt: t.created_at,
    })),
    history: history.map((h) => ({
      fromState: h.from_state,
      toState: h.to_state,
      reason: h.reason,
      source: h.source,
      createdAt: h.created_at,
    })),
  });
});

const verify = asyncHandler(async (req, res) => {
  const { gatewayOrderId, gatewayPaymentId, signature } = req.body;
  const intent = await paymentService.verifyPayment(req.params.paymentId, {
    gatewayOrderId,
    gatewayPaymentId,
    signature,
  });
  res.status(200).json(serializeIntent(intent));
});

module.exports = { create, get, verify };
