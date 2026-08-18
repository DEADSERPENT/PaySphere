const db = require('../../src/config/database');
const { up } = require('../../src/config/migrate');

async function migrate() {
  await db.withClient((client) => up(client));
}

/** Wipes every domain table between tests so cases run in isolation without needing a fresh database each time. */
async function truncateAll() {
  await db.query(`
    TRUNCATE TABLE
      payment_state_history,
      transactions,
      payment_attempts,
      payment_orders,
      idempotency_records,
      webhook_events,
      payment_intents
    RESTART IDENTITY CASCADE
  `);
}

async function closeDb() {
  await db.pool.end();
}

module.exports = { migrate, truncateAll, closeDb };
