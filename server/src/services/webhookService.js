const ids = require('../lib/ids');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const gatewayService = require('./gatewayService');
const paymentService = require('./paymentService');
const webhookRepository = require('../repositories/webhookRepository');
const paymentRepository = require('../repositories/paymentRepository');
const { RAZORPAY_TO_INTERNAL_PAYMENT_STATUS } = require('./razorpayAdapter');
const { UnauthorizedWebhookError, ValidationError } = require('../domain/errors');

// Event processor (spec section 8.5): the set of Razorpay webhook event
// types we act on. Anything else is persisted (for audit) but marked
// IGNORED rather than driving a state transition.
const HANDLED_EVENT_TYPES = new Set(['payment.authorized', 'payment.captured', 'payment.failed']);

function extractPaymentEntity(payload) {
  return payload && payload.payload && payload.payload.payment && payload.payload.payment.entity;
}

/**
 * Applies a single persisted webhook event to the payment state machine.
 * Tolerates duplicate delivery (caller only invokes this for newly-inserted
 * events), unknown orders, and unrecognized event types by marking the
 * event IGNORED instead of throwing — only genuine processing failures
 * (malformed payload, DB error) propagate so the caller can mark the event
 * FAILED and let it be retried (spec sections 8.5, 13, 14).
 */
async function processEvent(event) {
  if (!HANDLED_EVENT_TYPES.has(event.event_type)) {
    await webhookRepository.markIgnored(null, event.id, `Unhandled event type: ${event.event_type}`);
    return { applied: false, reason: 'unhandled_event_type' };
  }

  const paymentEntity = extractPaymentEntity(event.payload);
  if (!paymentEntity || !paymentEntity.order_id || !paymentEntity.id) {
    throw new ValidationError('Webhook payload missing payment entity');
  }

  const order = await paymentRepository.findOrderByGatewayOrderId(
    null,
    gatewayService.name,
    paymentEntity.order_id
  );
  if (!order) {
    await webhookRepository.markIgnored(null, event.id, `Unknown gateway order: ${paymentEntity.order_id}`);
    return { applied: false, reason: 'unknown_order' };
  }

  const gatewayPayment = {
    gatewayPaymentId: paymentEntity.id,
    gatewayOrderId: paymentEntity.order_id,
    status: RAZORPAY_TO_INTERNAL_PAYMENT_STATUS[paymentEntity.status] || String(paymentEntity.status).toUpperCase(),
    amount: paymentEntity.amount,
    currency: paymentEntity.currency,
    failureCode: paymentEntity.error_code || null,
    failureReason: paymentEntity.error_description || null,
  };

  const result = await paymentService.applyGatewayOutcome(order.payment_intent_id, gatewayPayment, {
    source: 'webhook',
    reason: `Webhook event ${event.event_type} (${event.gateway_event_id})`,
  });

  return { applied: result.applied, paymentIntentId: order.payment_intent_id };
}

/**
 * Webhook entry point (spec sections 8.4, 10.4, 13):
 *   verify signature -> persist -> deduplicate -> process -> acknowledge.
 * The signature check happens before any database write, so a forged
 * request can never mutate state (spec section 14).
 */
async function handleRazorpayWebhook({ rawBody, signature }) {
  const start = Date.now();

  if (!gatewayService.verifyWebhookSignature({ rawBody, signature })) {
    logger.warn({}, 'Rejected webhook with invalid signature');
    throw new UnauthorizedWebhookError('Invalid webhook signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ValidationError('Webhook payload is not valid JSON');
  }
  if (!payload.event || !payload.id) {
    throw new ValidationError('Webhook payload missing event/id');
  }

  metrics.webhookReceived(payload.event);

  const { event, created } = await webhookRepository.insertIfAbsent(null, {
    id: ids.webhookEventId(),
    gateway: gatewayService.name,
    gatewayEventId: payload.id,
    eventType: payload.event,
    payload,
  });

  if (!created) {
    metrics.webhookDuplicate();
    logger.info({ gatewayEventId: payload.id }, 'Duplicate webhook event ignored');
    return { status: 'DUPLICATE', event };
  }

  try {
    await processEvent(event);
    await webhookRepository.markProcessed(null, event.id);
    metrics.webhookLatency(Date.now() - start);
    return { status: 'PROCESSED', event };
  } catch (err) {
    await webhookRepository.markFailed(null, event.id, err.message);
    metrics.webhookLatency(Date.now() - start);
    logger.error({ gatewayEventId: payload.id, err: err.message }, 'Webhook event processing failed');
    throw err;
  }
}

module.exports = { handleRazorpayWebhook, processEvent, HANDLED_EVENT_TYPES };
