const ids = require('../lib/ids');
const context = require('../lib/context');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');

/**
 * Attaches a request/correlation ID to every request (generating one if the
 * caller didn't supply X-Correlation-Id), runs the rest of the request
 * inside an async-local-storage context carrying it, and logs
 * request/response with latency (spec section 19).
 */
function correlation(req, res, next) {
  const requestId = req.header('X-Correlation-Id') || req.header('X-Request-Id') || ids.requestId();
  res.setHeader('X-Correlation-Id', requestId);
  const start = Date.now();

  context.run({ requestId }, () => {
    logger.info({ method: req.method, path: req.path }, 'Request received');
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      metrics.apiLatency(req.route ? req.route.path : req.path, durationMs);
      logger.info(
        { method: req.method, path: req.path, statusCode: res.statusCode, durationMs },
        'Request completed'
      );
    });
    next();
  });
}

module.exports = correlation;
