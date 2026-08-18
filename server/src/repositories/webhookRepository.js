const db = require('../config/database');

function withExecutor(executor) {
  return executor || db.pool;
}

/**
 * Persists a webhook event. Relies on the UNIQUE (gateway, gateway_event_id)
 * constraint (migration 001) to make duplicate delivery a no-op: on
 * conflict this returns { created: false } instead of throwing, so the
 * caller can short-circuit processing (spec sections 11.4, 13, 14).
 */
async function insertIfAbsent(executor, event) {
  const { id, gateway, gatewayEventId, eventType, payload } = event;
  const { rows } = await withExecutor(executor).query(
    `INSERT INTO webhook_events (id, gateway, gateway_event_id, event_type, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'RECEIVED')
     ON CONFLICT (gateway, gateway_event_id) DO NOTHING
     RETURNING *`,
    [id, gateway, gatewayEventId, eventType, payload]
  );
  if (rows[0]) return { event: rows[0], created: true };

  const existing = await withExecutor(executor).query(
    'SELECT * FROM webhook_events WHERE gateway = $1 AND gateway_event_id = $2',
    [gateway, gatewayEventId]
  );
  return { event: existing.rows[0], created: false };
}

async function findById(executor, id) {
  const { rows } = await withExecutor(executor).query('SELECT * FROM webhook_events WHERE id = $1', [id]);
  return rows[0] || null;
}

async function markProcessed(executor, id) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(), error_message = NULL
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function markFailed(executor, id, errorMessage) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE webhook_events SET status = 'FAILED', error_message = $2 WHERE id = $1 RETURNING *`,
    [id, errorMessage]
  );
  return rows[0] || null;
}

async function markIgnored(executor, id, reason) {
  const { rows } = await withExecutor(executor).query(
    `UPDATE webhook_events SET status = 'IGNORED', processed_at = now(), error_message = $2
     WHERE id = $1 RETURNING *`,
    [id, reason]
  );
  return rows[0] || null;
}

async function findPendingForRetry(executor, limit = 50) {
  const { rows } = await withExecutor(executor).query(
    `SELECT * FROM webhook_events WHERE status IN ('RECEIVED', 'FAILED') ORDER BY received_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { insertIfAbsent, findById, markProcessed, markFailed, markIgnored, findPendingForRetry };
