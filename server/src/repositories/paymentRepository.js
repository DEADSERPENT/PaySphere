const db = require('../config/database');

/**
 * Every function accepts an optional `executor` (a pg PoolClient, when the
 * caller is inside a transaction) and falls back to the shared pool
 * otherwise. This lets the same repository code run standalone or as part
 * of a larger transactional unit of work (spec section 15).
 */
function withExecutor(executor) {
  return executor || db.pool;
}

async function insertIntent(executor, intent) {
  const { id, externalOrderId, amount, currency, status, customerReference, metadata } = intent;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO payment_intents
       (id, external_order_id, amount, currency, status, customer_reference, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [id, externalOrderId, amount, currency, status, customerReference || null, metadata || {}]
  );
  return rows[0];
}

async function findIntentById(executor, id) {
  const { rows } = await withExecutor(executor).query('SELECT * FROM payment_intents WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Row-level lock used before validating/applying a state transition (spec section 12/13). */
async function lockIntentById(executor, id) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE',
    [id]
  );
  return rows[0] || null;
}

async function updateIntentStatus(executor, id, status) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE payment_intents SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

async function findStuckIntents(executor, { statuses, olderThan }) {
  const { rows } = await withExecutor(executor).query(
    `SELECT * FROM payment_intents
     WHERE status = ANY($1::text[]) AND updated_at < $2
     ORDER BY updated_at ASC
     LIMIT 200`,
    [statuses, olderThan]
  );
  return rows;
}

/**
 * createPayment wraps this in retryWithBackoff to survive transient DB
 * blips after the gateway order already exists upstream. If a write
 * actually succeeds but its acknowledgment is lost (rare, but possible),
 * a retry must not crash on the (gateway, gateway_order_id) unique
 * constraint -- ON CONFLICT DO NOTHING plus a fallback lookup makes the
 * insert idempotent, matching the same pattern insertTransactionIfAbsent
 * already uses for the equivalent problem on `transactions`.
 */
async function insertOrder(executor, order) {
  const { id, paymentIntentId, gateway, gatewayOrderId, status } = order;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO payment_orders (id, payment_intent_id, gateway, gateway_order_id, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (gateway, gateway_order_id) DO NOTHING
     RETURNING *`,
    [id, paymentIntentId, gateway, gatewayOrderId, status]
  );
  if (rows[0]) return rows[0];
  return findOrderByGatewayOrderId(executor, gateway, gatewayOrderId);
}

async function findOrderByGatewayOrderId(executor, gateway, gatewayOrderId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_orders WHERE gateway = $1 AND gateway_order_id = $2',
    [gateway, gatewayOrderId]
  );
  return rows[0] || null;
}

async function findOrdersByIntentId(executor, paymentIntentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_orders WHERE payment_intent_id = $1 ORDER BY created_at ASC',
    [paymentIntentId]
  );
  return rows;
}

async function insertAttempt(executor, attempt) {
  const {
    id,
    paymentIntentId,
    attemptNumber,
    gateway,
    gatewayPaymentId,
    status,
    failureCode,
    failureReason,
  } = attempt;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO payment_attempts
       (id, payment_intent_id, attempt_number, gateway, gateway_payment_id, status, failure_code, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      paymentIntentId,
      attemptNumber,
      gateway,
      gatewayPaymentId || null,
      status,
      failureCode || null,
      failureReason || null,
    ]
  );
  return rows[0];
}

/**
 * Like insertAttempt, but for the authoritative gateway-outcome path
 * (applyGatewayOutcome): Razorpay commonly sends more than one webhook for
 * the *same* attempt as it progresses (e.g. payment.authorized then
 * payment.captured share one gatewayPaymentId), and uq_payment_attempts_gateway_payment_id
 * allows only one row per (gateway, gatewayPaymentId). A plain insert on the
 * second event would violate that constraint and crash webhook processing.
 * On conflict, update the existing row's outcome in place instead of
 * inserting a duplicate -- attempt_number is deliberately left untouched so
 * the row keeps identifying the same attempt throughout its lifecycle.
 */
async function upsertAttempt(executor, attempt) {
  const {
    id,
    paymentIntentId,
    attemptNumber,
    gateway,
    gatewayPaymentId,
    status,
    failureCode,
    failureReason,
  } = attempt;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO payment_attempts
       (id, payment_intent_id, attempt_number, gateway, gateway_payment_id, status, failure_code, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (gateway, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status, failure_code = EXCLUDED.failure_code,
       failure_reason = EXCLUDED.failure_reason, updated_at = now()
     RETURNING *`,
    [
      id,
      paymentIntentId,
      attemptNumber,
      gateway,
      gatewayPaymentId || null,
      status,
      failureCode || null,
      failureReason || null,
    ]
  );
  return rows[0];
}

async function nextAttemptNumber(executor, paymentIntentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM payment_attempts WHERE payment_intent_id = $1',
    [paymentIntentId]
  );
  return rows[0].next;
}

async function findAttemptByGatewayPaymentId(executor, gateway, gatewayPaymentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_attempts WHERE gateway = $1 AND gateway_payment_id = $2',
    [gateway, gatewayPaymentId]
  );
  return rows[0] || null;
}

async function findAttemptsByIntentId(executor, paymentIntentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_attempts WHERE payment_intent_id = $1 ORDER BY attempt_number ASC',
    [paymentIntentId]
  );
  return rows;
}

/**
 * Creates the local financial transaction record. Relies on the unique
 * index on gateway_payment_id (migration 001) to guarantee the same
 * gateway event can never produce two transactions; on conflict this
 * returns the existing row instead of throwing, so callers can treat
 * "already recorded" as an idempotent success rather than an error.
 */
async function insertTransactionIfAbsent(executor, transaction) {
  const { id, paymentIntentId, gatewayPaymentId, amount, currency, status } = transaction;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO transactions (id, payment_intent_id, gateway_payment_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (gateway_payment_id) DO NOTHING
     RETURNING *`,
    [id, paymentIntentId, gatewayPaymentId, amount, currency, status]
  );
  if (rows[0]) return { transaction: rows[0], created: true };

  const existing = await withExecutor(executor).query(
    'SELECT * FROM transactions WHERE gateway_payment_id = $1',
    [gatewayPaymentId]
  );
  return { transaction: existing.rows[0], created: false };
}

async function findTransactionsByIntentId(executor, paymentIntentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM transactions WHERE payment_intent_id = $1 ORDER BY created_at ASC',
    [paymentIntentId]
  );
  return rows;
}

async function insertStateHistory(executor, history) {
  const { id, paymentIntentId, fromState, toState, reason, source } = history;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO payment_state_history (id, payment_intent_id, from_state, to_state, reason, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, paymentIntentId, fromState || null, toState, reason || null, source]
  );
  return rows[0];
}

async function findStateHistory(executor, paymentIntentId) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM payment_state_history WHERE payment_intent_id = $1 ORDER BY created_at ASC',
    [paymentIntentId]
  );
  return rows;
}

module.exports = {
  insertIntent,
  findIntentById,
  lockIntentById,
  updateIntentStatus,
  findStuckIntents,
  insertOrder,
  findOrderByGatewayOrderId,
  findOrdersByIntentId,
  insertAttempt,
  upsertAttempt,
  nextAttemptNumber,
  findAttemptByGatewayPaymentId,
  findAttemptsByIntentId,
  insertTransactionIfAbsent,
  findTransactionsByIntentId,
  insertStateHistory,
  findStateHistory,
};
