const env = require('../config/env');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');
const gatewayService = require('./gatewayService');
const paymentService = require('./paymentService');
const paymentRepository = require('../repositories/paymentRepository');
const { STATES } = require('../domain/paymentStates');

/**
 * Picks the single authoritative outcome out of every payment attempt the
 * gateway has recorded for an order: a capture wins over anything else, a
 * failure wins if nothing succeeded, and an in-flight authorization is
 * reported as unresolved so the caller leaves the payment alone for the
 * next reconciliation pass (spec section 17 diagram).
 */
function pickAuthoritativeOutcome(gatewayPayments) {
  const captured = gatewayPayments.find((p) => p.status === 'CAPTURED');
  if (captured) return { outcome: 'SUCCESS', payment: captured };

  const authorized = gatewayPayments.find((p) => p.status === 'AUTHORIZED');
  if (authorized) return { outcome: 'UNKNOWN', payment: authorized };

  const failed = gatewayPayments.find((p) => p.status === 'FAILED');
  if (failed) return { outcome: 'FAILED', payment: failed };

  return { outcome: 'NO_ATTEMPT', payment: null };
}

/**
 * Reconciles a single stuck payment intent against gateway state (spec
 * section 17): queries every payment order recorded for the intent, asks
 * the gateway for its authoritative view, and applies the one repair
 * transition the outcome allows. Never guesses — an ambiguous or
 * still-in-flight gateway state is left untouched for the next pass.
 */
async function reconcileIntent(intent, { abandonedAfterMs }) {
  const orders = await paymentRepository.findOrdersByIntentId(null, intent.id);
  if (orders.length === 0) {
    logger.warn({ paymentIntentId: intent.id }, 'Stuck payment has no gateway order; nothing to reconcile');
    return { outcome: 'NO_ORDER' };
  }

  // V1 creates exactly one order per intent; reconcile against the most recent.
  const order = orders[orders.length - 1];
  const gatewayPayments = await gatewayService.fetchPaymentsForOrder(order.gateway_order_id);
  const { outcome, payment } = pickAuthoritativeOutcome(gatewayPayments);

  switch (outcome) {
    case 'SUCCESS':
    case 'FAILED': {
      const result = await paymentService.applyGatewayOutcome(intent.id, payment, {
        source: 'reconciliation',
        reason: `Reconciliation repair from gateway state (${outcome.toLowerCase()})`,
      });
      metrics.reconciliationRepair(outcome.toLowerCase());
      logger.info({ paymentIntentId: intent.id, outcome, applied: result.applied }, 'Reconciliation repair applied');
      return { outcome, applied: result.applied };
    }
    case 'NO_ATTEMPT': {
      const ageMs = Date.now() - new Date(intent.updated_at).getTime();
      if (ageMs < abandonedAfterMs) {
        return { outcome: 'TOO_RECENT_TO_EXPIRE' };
      }
      const result = await paymentService.expireStalePayment(
        intent.id,
        'No gateway payment attempt recorded before reconciliation timeout'
      );
      metrics.reconciliationRepair('expired');
      logger.info({ paymentIntentId: intent.id }, 'Reconciliation expired abandoned payment');
      return { outcome: 'EXPIRED', applied: result.applied };
    }
    case 'UNKNOWN':
    default:
      logger.info({ paymentIntentId: intent.id, outcome }, 'Reconciliation outcome inconclusive; will recheck later');
      metrics.reconciliationRepair('unknown_recheck');
      return { outcome: 'UNKNOWN' };
  }
}

/**
 * Scans PENDING/PROCESSING payments older than their configured timeout
 * and reconciles each one. Designed to be called on a fixed interval by
 * paymentWorker.js (or on demand via an operator-triggered endpoint/script).
 */
async function runReconciliationSweep() {
  const now = Date.now();
  const pendingCutoff = new Date(now - env.reconciliation.stuckPendingMinutes * 60 * 1000);
  const processingCutoff = new Date(now - env.reconciliation.stuckProcessingMinutes * 60 * 1000);

  const [stuckPending, stuckProcessing] = await Promise.all([
    paymentRepository.findStuckIntents(null, { statuses: [STATES.PENDING], olderThan: pendingCutoff }),
    paymentRepository.findStuckIntents(null, { statuses: [STATES.PROCESSING], olderThan: processingCutoff }),
  ]);

  const candidates = [...stuckPending, ...stuckProcessing];
  metrics.stuckPaymentsGauge(candidates.length);

  if (candidates.length === 0) {
    logger.debug({}, 'Reconciliation sweep found no stuck payments');
    return { scanned: 0, results: [] };
  }

  logger.info({ count: candidates.length }, 'Reconciliation sweep starting');

  const results = [];
  for (const intent of candidates) {
    try {
      const result = await reconcileIntent(intent, {
        abandonedAfterMs: env.reconciliation.stuckPendingMinutes * 60 * 1000,
      });
      results.push({ paymentIntentId: intent.id, ...result });
    } catch (err) {
      logger.error({ paymentIntentId: intent.id, err: err.message }, 'Reconciliation failed for payment');
      results.push({ paymentIntentId: intent.id, outcome: 'ERROR', error: err.message });
    }
  }

  logger.info({ count: candidates.length }, 'Reconciliation sweep finished');
  return { scanned: candidates.length, results };
}

module.exports = { runReconciliationSweep, reconcileIntent, pickAuthoritativeOutcome };
