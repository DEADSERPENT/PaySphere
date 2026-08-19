const db = require('../config/database');
const ids = require('../lib/ids');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const { retryWithBackoff } = require('../lib/retry');
const gatewayService = require('./gatewayService');
const paymentRepository = require('../repositories/paymentRepository');
const { STATES, isTerminal } = require('../domain/paymentStates');
const { canTransition, assertValidTransition } = require('../domain/paymentTransitions');
const { GATEWAY_STATUS_TO_STATE } = require('../domain/gatewayStatusMapping');
const { NotFoundError, VerificationFailedError } = require('../domain/errors');

/**
 * Creates a payment intent and its gateway order.
 *
 * The intent row is persisted (CREATED -> PENDING) and committed *before*
 * the gateway is called: if the gateway call then fails, we already have a
 * durable, auditable, terminal record of the attempt instead of a dangling
 * in-memory operation the caller can't inspect (spec: durability,
 * traceability). If the gateway call fails, the intent is moved to FAILED
 * so a stuck-PENDING reconciliation scan never has to consider it.
 */
async function createPayment({ externalOrderId, amount, currency, customerReference, metadata }) {
  const intentId = ids.paymentIntentId();
  const normalizedCurrency = currency.toUpperCase();

  await db.withTransaction(async (client) => {
    await paymentRepository.insertIntent(client, {
      id: intentId,
      externalOrderId,
      amount,
      currency: normalizedCurrency,
      status: STATES.CREATED,
      customerReference,
      metadata,
    });
    await paymentRepository.insertStateHistory(client, {
      id: ids.stateHistoryId(),
      paymentIntentId: intentId,
      fromState: null,
      toState: STATES.CREATED,
      reason: 'Payment intent created',
      source: 'system',
    });
    await paymentRepository.updateIntentStatus(client, intentId, STATES.PENDING);
    await paymentRepository.insertStateHistory(client, {
      id: ids.stateHistoryId(),
      paymentIntentId: intentId,
      fromState: STATES.CREATED,
      toState: STATES.PENDING,
      reason: 'Awaiting gateway order creation',
      source: 'system',
    });
  });

  let order;
  try {
    order = await gatewayService.createOrder({
      amount,
      currency: normalizedCurrency,
      receipt: externalOrderId,
      notes: { paymentIntentId: intentId },
    });
  } catch (err) {
    logger.error({ paymentIntentId: intentId, err: err.message }, 'Gateway order creation failed');
    await db.withTransaction(async (client) => {
      await paymentRepository.updateIntentStatus(client, intentId, STATES.FAILED);
      await paymentRepository.insertStateHistory(client, {
        id: ids.stateHistoryId(),
        paymentIntentId: intentId,
        fromState: STATES.PENDING,
        toState: STATES.FAILED,
        reason: `Gateway order creation failed: ${err.message}`,
        source: 'system',
      });
    });
    metrics.paymentFailed();
    throw err;
  }

  // The gateway order already exists at this point. A failure to persist it
  // locally must not silently orphan that gateway order: retry the local
  // write (it's almost always a transient DB blip, not a logic error), and
  // if it's still unrecoverable, terminate the intent so it's explainable
  // rather than stuck PENDING with no order row for reconciliation to find.
  let paymentOrder;
  try {
    paymentOrder = await retryWithBackoff(
      () =>
        db.withTransaction((client) =>
          paymentRepository.insertOrder(client, {
            id: ids.paymentOrderId(),
            paymentIntentId: intentId,
            gateway: gatewayService.name,
            gatewayOrderId: order.gatewayOrderId,
            status: order.status,
          })
        ),
      { operation: 'persistPaymentOrder', maxAttempts: 3, baseDelayMs: 100 }
    );
  } catch (err) {
    logger.error(
      { paymentIntentId: intentId, gatewayOrderId: order.gatewayOrderId, err: err.message },
      'Failed to persist gateway order after it was created upstream; failing the intent'
    );
    await db.withTransaction(async (client) => {
      await paymentRepository.updateIntentStatus(client, intentId, STATES.FAILED);
      await paymentRepository.insertStateHistory(client, {
        id: ids.stateHistoryId(),
        paymentIntentId: intentId,
        fromState: STATES.PENDING,
        toState: STATES.FAILED,
        reason: `Gateway order ${order.gatewayOrderId} was created but could not be persisted locally: ${err.message}`,
        source: 'system',
      });
    });
    metrics.paymentFailed();
    throw err;
  }

  metrics.paymentCreated();
  const intent = await paymentRepository.findIntentById(null, intentId);
  return { intent, order: paymentOrder };
}

async function getPayment(paymentIntentId) {
  const intent = await paymentRepository.findIntentById(null, paymentIntentId);
  if (!intent) throw new NotFoundError(`Payment not found: ${paymentIntentId}`);

  const [orders, attempts, transactions, history] = await Promise.all([
    paymentRepository.findOrdersByIntentId(null, paymentIntentId),
    paymentRepository.findAttemptsByIntentId(null, paymentIntentId),
    paymentRepository.findTransactionsByIntentId(null, paymentIntentId),
    paymentRepository.findStateHistory(null, paymentIntentId),
  ]);

  return { intent, orders, attempts, transactions, history };
}

/**
 * Records a client-reported payment failure (e.g. Razorpay checkout's
 * `payment.failed` event) as an audit-only attempt row. Deliberately never
 * changes the payment's state — client-side signals are not authoritative
 * (spec section 7, invariant: "client-side success is not authoritative").
 * This exists purely so a failed attempt is visible immediately instead of
 * only after the next reconciliation sweep discovers it from gateway state.
 */
async function reportClientFailure(paymentIntentId, { gatewayPaymentId, code, description }) {
  try {
    return await db.withTransaction(async (client) => {
      const intent = await paymentRepository.lockIntentById(client, paymentIntentId);
      if (!intent) throw new NotFoundError(`Payment not found: ${paymentIntentId}`);

      const attemptNumber = await paymentRepository.nextAttemptNumber(client, paymentIntentId);
      const attempt = await paymentRepository.insertAttempt(client, {
        id: ids.paymentAttemptId(),
        paymentIntentId,
        attemptNumber,
        gateway: gatewayService.name,
        gatewayPaymentId: gatewayPaymentId || null,
        status: 'CLIENT_REPORTED_FAILURE',
        failureCode: code || null,
        failureReason: description || null,
      });

      metrics.clientReportedFailure();
      logger.warn(
        { paymentIntentId, gatewayPaymentId, code, description },
        'Client reported a failed payment attempt'
      );
      return attempt;
    });
  } catch (err) {
    if (err.code === '23505' && gatewayPaymentId) {
      // Same gatewayPaymentId reported twice (e.g. a duplicate client-side
      // event) -- harmless, return the attempt already recorded for it.
      return paymentRepository.findAttemptByGatewayPaymentId(null, gatewayService.name, gatewayPaymentId);
    }
    throw err;
  }
}

/**
 * Applies an authoritative gateway payment outcome to a payment intent.
 * This is the single choke point every path that can change payment state
 * from a gateway fact — the /verify endpoint, webhook event processing, and
 * reconciliation — funnels through, so the invariants in spec section 7
 * (atomicity, no double transactions, auditability) only have to be
 * enforced in one place.
 *
 * Idempotent by construction: re-applying the same gateway outcome for a
 * payment already in the target state, or already terminal, is a no-op.
 */
async function applyGatewayOutcome(paymentIntentId, gatewayPayment, { source, reason }) {
  return db.withTransaction(async (client) => {
    const intent = await paymentRepository.lockIntentById(client, paymentIntentId);
    if (!intent) throw new NotFoundError(`Payment not found: ${paymentIntentId}`);

    const targetState = GATEWAY_STATUS_TO_STATE[gatewayPayment.status];
    if (!targetState) {
      logger.info(
        { paymentIntentId, gatewayStatus: gatewayPayment.status },
        'Gateway status has no mapped state transition; ignoring'
      );
      return { intent, applied: false };
    }

    if (isTerminal(intent.status) || intent.status === targetState) {
      logger.info(
        { paymentIntentId, status: intent.status, targetState },
        'Payment already settled/terminal; treating gateway outcome as duplicate'
      );
      return { intent, applied: false };
    }

    if (!canTransition(intent.status, targetState)) {
      logger.warn(
        { paymentIntentId, from: intent.status, to: targetState },
        'Ignoring out-of-order or invalid gateway transition'
      );
      return { intent, applied: false, ignored: true };
    }

    // Invariant (spec section 7): a transaction's amount/currency must match
    // the intent unless an explicit adjustment is supported (it isn't, yet).
    if (
      targetState === STATES.SUCCEEDED &&
      (gatewayPayment.amount !== intent.amount || gatewayPayment.currency !== intent.currency)
    ) {
      logger.error(
        {
          paymentIntentId,
          intentAmount: intent.amount,
          intentCurrency: intent.currency,
          gatewayAmount: gatewayPayment.amount,
          gatewayCurrency: gatewayPayment.currency,
        },
        'Gateway payment amount/currency mismatch; refusing to mark payment succeeded'
      );
      const attemptNumber = await paymentRepository.nextAttemptNumber(client, paymentIntentId);
      await paymentRepository.insertAttempt(client, {
        id: ids.paymentAttemptId(),
        paymentIntentId,
        attemptNumber,
        gateway: gatewayService.name,
        gatewayPaymentId: gatewayPayment.gatewayPaymentId,
        status: 'MISMATCHED',
        failureCode: 'AMOUNT_CURRENCY_MISMATCH',
        failureReason: 'Gateway payment amount/currency did not match the payment intent',
      });
      return { intent, applied: false, mismatched: true };
    }

    assertValidTransition(intent.status, targetState);

    const attemptNumber = await paymentRepository.nextAttemptNumber(client, paymentIntentId);
    await paymentRepository.insertAttempt(client, {
      id: ids.paymentAttemptId(),
      paymentIntentId,
      attemptNumber,
      gateway: gatewayService.name,
      gatewayPaymentId: gatewayPayment.gatewayPaymentId,
      status: targetState,
      failureCode: gatewayPayment.failureCode,
      failureReason: gatewayPayment.failureReason,
    });

    let updated = await paymentRepository.updateIntentStatus(client, paymentIntentId, targetState);
    await paymentRepository.insertStateHistory(client, {
      id: ids.stateHistoryId(),
      paymentIntentId,
      fromState: intent.status,
      toState: targetState,
      reason,
      source,
    });

    if (targetState === STATES.SUCCEEDED) {
      await paymentRepository.insertTransactionIfAbsent(client, {
        id: ids.transactionId(),
        paymentIntentId,
        gatewayPaymentId: gatewayPayment.gatewayPaymentId,
        amount: gatewayPayment.amount,
        currency: gatewayPayment.currency,
        status: 'CAPTURED',
      });

      updated = await paymentRepository.updateIntentStatus(client, paymentIntentId, STATES.COMPLETED);
      await paymentRepository.insertStateHistory(client, {
        id: ids.stateHistoryId(),
        paymentIntentId,
        fromState: STATES.SUCCEEDED,
        toState: STATES.COMPLETED,
        reason: 'Local transaction record settled',
        source: 'system',
      });
      metrics.paymentSucceeded();
    }

    if (targetState === STATES.FAILED) {
      metrics.paymentFailed();
    }

    return { intent: updated, applied: true };
  });
}

/**
 * Server-side payment verification (spec section 10.3). Never trusts the
 * client's assertion of success: it cryptographically verifies the
 * checkout signature, then fetches the payment directly from the gateway
 * and applies whatever the gateway reports through the same authoritative
 * path webhooks use.
 */
async function verifyPayment(paymentIntentId, { gatewayOrderId, gatewayPaymentId, signature }) {
  const intent = await paymentRepository.findIntentById(null, paymentIntentId);
  if (!intent) throw new NotFoundError(`Payment not found: ${paymentIntentId}`);

  const order = await paymentRepository.findOrderByGatewayOrderId(null, gatewayService.name, gatewayOrderId);
  if (!order || order.payment_intent_id !== paymentIntentId) {
    throw new VerificationFailedError('gatewayOrderId does not belong to this payment');
  }

  const signatureValid = gatewayService.verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature });
  if (!signatureValid) {
    logger.warn({ paymentIntentId, gatewayOrderId, gatewayPaymentId }, 'Payment verification signature mismatch');
    throw new VerificationFailedError('Payment signature verification failed');
  }

  const gatewayPayment = await gatewayService.fetchPayment(gatewayPaymentId);
  if (gatewayPayment.gatewayOrderId !== gatewayOrderId) {
    throw new VerificationFailedError('gatewayPaymentId does not belong to gatewayOrderId');
  }

  const result = await applyGatewayOutcome(paymentIntentId, gatewayPayment, {
    source: 'client_verification',
    reason: `Server-side verification against gateway payment ${gatewayPaymentId}`,
  });

  return result.intent;
}

/**
 * Marks a payment EXPIRED when reconciliation determines it has been stuck
 * with no gateway-side attempt for too long (spec section 17: "Gateway
 * UNKNOWN/no attempt -> expire"). Distinct from applyGatewayOutcome because
 * this transition is driven by the *absence* of a gateway fact, not by one.
 */
async function expireStalePayment(paymentIntentId, reason) {
  return db.withTransaction(async (client) => {
    const intent = await paymentRepository.lockIntentById(client, paymentIntentId);
    if (!intent) throw new NotFoundError(`Payment not found: ${paymentIntentId}`);

    if (isTerminal(intent.status) || !canTransition(intent.status, STATES.EXPIRED)) {
      return { intent, applied: false };
    }

    const updated = await paymentRepository.updateIntentStatus(client, paymentIntentId, STATES.EXPIRED);
    await paymentRepository.insertStateHistory(client, {
      id: ids.stateHistoryId(),
      paymentIntentId,
      fromState: intent.status,
      toState: STATES.EXPIRED,
      reason,
      source: 'reconciliation',
    });
    metrics.paymentFailed();
    return { intent: updated, applied: true };
  });
}

module.exports = {
  createPayment,
  getPayment,
  verifyPayment,
  applyGatewayOutcome,
  expireStalePayment,
  reportClientFailure,
};
