const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const correlation = require('./middleware/correlation');
const securityHeaders = require('./middleware/securityHeaders');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const paymentRoutes = require('./routes/paymentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }
  app.use(securityHeaders);
  app.use(securityHeaders.enforceHttps(env));

  // Captures the exact bytes received so webhook signature verification
  // (HMAC over the raw body) never operates on a re-serialized JSON string
  // that could legitimately differ byte-for-byte from what the gateway signed.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  app.use(correlation);

  // Payment endpoints are called per end-user action, so a per-caller
  // budget makes sense. The webhook endpoint is server-to-server from the
  // gateway and can legitimately burst (e.g. a backlog being redelivered),
  // so it gets its own, more generous limiter rather than sharing the
  // per-client budget (spec section 18: rate limiting on public endpoints).
  const paymentLimiter = rateLimit({
    windowMs: env.rateLimit.windowMs,
    max: env.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const webhookLimiter = rateLimit({
    windowMs: env.rateLimit.windowMs,
    max: env.rateLimit.max * 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/metrics', (req, res) => res.status(200).type('text/plain').send(metrics.render()));

  app.use('/api/v1/payments', paymentLimiter, paymentRoutes);
  app.use('/api/v1/webhooks', webhookLimiter, webhookRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(env.port, () => {
    logger.info({ port: env.port, nodeEnv: env.nodeEnv, gatewayAdapter: env.gatewayAdapter }, 'PaySphere listening');
  });
}

module.exports = { createApp };
