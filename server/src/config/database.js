const { Pool, types } = require('pg');
const env = require('./env');
const logger = require('../lib/logger');

// `pg` returns BIGINT (OID 20) columns as strings by default, since they
// can exceed Number.MAX_SAFE_INTEGER. Payment amounts here are always well
// within that range, so parsing them as numbers avoids silent type
// mismatches (e.g. "30000" !== 30000) when comparing a DB-loaded intent's
// amount against a gateway-reported amount (spec section 7 invariant).
types.setTypeParser(20, (value) => parseInt(value, 10));

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.databasePoolMax,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
});

/**
 * Runs `fn` inside a single client checked out from the pool, so callers
 * that need multiple statements against the *same* connection (transactions,
 * advisory locks) don't accidentally spread them across different pooled
 * connections.
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction, rolling back on any thrown
 * error. This is the primitive every transactional-consistency guarantee in
 * the spec (section 15) is built on top of.
 */
async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, withClient, withTransaction };
