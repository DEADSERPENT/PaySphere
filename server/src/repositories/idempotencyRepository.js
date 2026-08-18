const db = require('../config/database');

function withExecutor(executor) {
  return executor || db.pool;
}

/**
 * Attempts to claim an idempotency key by inserting an IN_PROGRESS record.
 * The UNIQUE (scope, idempotency_key) constraint (migration 001) is the
 * concurrency primitive: if two requests race on the same key, exactly one
 * INSERT wins and the other observes { claimed: false } and must look up
 * the existing record instead (spec sections 11, 12).
 */
async function claim(executor, { id, scope, idempotencyKey, requestHash, expiresAt }) {
  try {
    const { rows } = await withExecutor(executor).query(
      `INSERT INTO idempotency_records (id, scope, idempotency_key, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5)
       RETURNING *`,
      [id, scope, idempotencyKey, requestHash, expiresAt]
    );
    return { claimed: true, record: rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      return { claimed: false, record: await findByKey(executor, scope, idempotencyKey) };
    }
    throw err;
  }
}

async function findByKey(executor, scope, idempotencyKey) {
  const { rows } = await withExecutor(executor).query(
    'SELECT * FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2',
    [scope, idempotencyKey]
  );
  return rows[0] || null;
}

async function complete(executor, id, { paymentIntentId, responseStatus, responsePayload }) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE idempotency_records
     SET status = 'COMPLETED', payment_intent_id = $2, response_status = $3, response_payload = $4
     WHERE id = $1
     RETURNING *`,
    [id, paymentIntentId, responseStatus, responsePayload]
  );
  return rows[0] || null;
}

/** Releases a claimed key so a later retry can attempt the operation again (used when the underlying write fails). */
async function release(executor, id) {
  await withExecutor(executor).query('DELETE FROM idempotency_records WHERE id = $1', [id]);
}

/**
 * Reclaims an IN_PROGRESS record whose claimant crashed without completing
 * or releasing it (spec section 14 "Worker crash", section 16 "persist
 * retry state rather than relying only on in-memory timers"). The WHERE
 * clause re-checks `created_at < staleBefore` at UPDATE time, so if two
 * retries race to reclaim the same abandoned key, only the first succeeds —
 * its UPDATE resets created_at to now(), which makes the second UPDATE's
 * WHERE clause no longer match. Returns null if the record was not stale
 * (still genuinely in progress) or was already reclaimed by a concurrent retry.
 */
async function reclaimStale(executor, { scope, idempotencyKey, requestHash, expiresAt, staleBefore }) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE idempotency_records
     SET request_hash = $3, status = 'IN_PROGRESS', created_at = now(), expires_at = $4,
         payment_intent_id = NULL, response_status = NULL, response_payload = NULL
     WHERE scope = $1 AND idempotency_key = $2 AND status = 'IN_PROGRESS' AND created_at < $5
     RETURNING *`,
    [scope, idempotencyKey, requestHash, expiresAt, staleBefore]
  );
  return rows[0] || null;
}

module.exports = { claim, findByKey, complete, release, reclaimStale };
