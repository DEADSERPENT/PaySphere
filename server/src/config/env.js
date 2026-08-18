const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  databaseUrl:
    process.env.NODE_ENV === 'test'
      ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
      : process.env.DATABASE_URL,
  databasePoolMax: int(process.env.DATABASE_POOL_MAX, 10),

  gatewayAdapter: process.env.GATEWAY_ADAPTER || 'mock',
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  idempotencyTtlHours: int(process.env.IDEMPOTENCY_TTL_HOURS, 24),
  // How long an IN_PROGRESS idempotency claim is honored before it's treated
  // as abandoned (the process that claimed it crashed before completing or
  // releasing it) and reclaimable by a retry. Deliberately much shorter than
  // the TTL above, which governs how long a COMPLETED response is replayed.
  idempotencyInProgressTimeoutMs: int(process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS, 30000),

  reconciliation: {
    stuckPendingMinutes: int(process.env.RECONCILIATION_STUCK_PENDING_MINUTES, 15),
    stuckProcessingMinutes: int(process.env.RECONCILIATION_STUCK_PROCESSING_MINUTES, 30),
    intervalMs: int(process.env.RECONCILIATION_INTERVAL_MS, 60000),
  },

  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: int(process.env.RATE_LIMIT_MAX, 120),
  },
};

module.exports = env;
