/**
 * A small, dependency-free set of defensive HTTP headers (spec section 18).
 * PaySphere is a JSON API with no browser-rendered HTML, so the classic
 * helmet feature set (CSP for inline scripts, etc.) mostly doesn't apply;
 * these are the headers that matter for a pure API surface.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Rejects plaintext HTTP in production (spec section 18: "Use HTTPS in
 * deployed environments"). Relies on `app.set('trust proxy', ...)` being
 * configured so `req.secure` reflects the original scheme when running
 * behind a TLS-terminating load balancer/reverse proxy. A no-op outside
 * production so local development over plain HTTP keeps working.
 */
function enforceHttps(env) {
  return function enforceHttpsMiddleware(req, res, next) {
    if (env.nodeEnv !== 'production' || req.secure) return next();
    return res.status(400).json({
      error: { code: 'HTTPS_REQUIRED', message: 'HTTPS is required in production' },
    });
  };
}

module.exports = securityHeaders;
module.exports.enforceHttps = enforceHttps;
