const pino = require('pino');
const context = require('./context');

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Wraps pino so every call automatically merges in the current async
 * context (requestId / paymentId / correlationId) without callers having to
 * pass it explicitly. Produces structured JSON logs per spec section 19.
 */
function withContext(fields) {
  return { ...context.get(), ...fields };
}

const logger = {
  child(bindings) {
    return base.child(bindings);
  },
  info(fields, msg) {
    base.info(withContext(fields), msg);
  },
  warn(fields, msg) {
    base.warn(withContext(fields), msg);
  },
  error(fields, msg) {
    base.error(withContext(fields), msg);
  },
  debug(fields, msg) {
    base.debug(withContext(fields), msg);
  },
};

module.exports = logger;
