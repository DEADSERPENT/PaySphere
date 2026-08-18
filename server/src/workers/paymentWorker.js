#!/usr/bin/env node
/**
 * Standalone reconciliation worker (spec sections 8.6, 17, 21). Runs the
 * reconciliation sweep on a fixed interval. Deliberately a separate
 * process from the API server (`npm run worker`) so reconciliation load
 * never competes with request-serving capacity — the first step toward the
 * V3 distributed-worker model without requiring Redis/a queue yet.
 */
const env = require('../config/env');
const logger = require('../lib/logger');
const reconciliationService = require('../services/reconciliationService');

let stopping = false;

async function tick() {
  if (stopping) return;
  try {
    await reconciliationService.runReconciliationSweep();
  } catch (err) {
    logger.error({ err: err.message }, 'Reconciliation sweep crashed');
  }
}

function start() {
  logger.info({ intervalMs: env.reconciliation.intervalMs }, 'Payment worker starting');
  const interval = setInterval(tick, env.reconciliation.intervalMs);
  tick();

  const shutdown = () => {
    stopping = true;
    clearInterval(interval);
    logger.info({}, 'Payment worker stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start();
}

module.exports = { start, tick };
