const logger = require('./logger');
const metrics = require('./metrics');

/**
 * Errors that represent a permanent rejection (bad signature, invalid
 * request, business-rule violation) must never be retried — retrying them
 * only delays the correct failure response (spec section 16).
 */
class PermanentError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PermanentError';
    this.cause = cause;
    this.retryable = false;
    // Preserve the upstream HTTP status (e.g. 401 from an auth failure, 400
    // from a rejected request) so the error handler can surface it as-is
    // instead of collapsing every permanent gateway failure into a generic 500.
    this.statusCode = cause && (cause.statusCode || cause.status || (cause.response && cause.response.status));
    this.code = this.statusCode === 401 || this.statusCode === 403 ? 'GATEWAY_AUTH_FAILED' : 'GATEWAY_REQUEST_REJECTED';
  }
}

/**
 * Errors that represent a transient condition (network blip, gateway 5xx,
 * timeout) are safe to retry with backoff.
 */
class TransientError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TransientError';
    this.cause = cause;
    this.retryable = true;
  }
}

/** Classifies a raw error/HTTP status into retryable vs permanent. */
function classify(err) {
  if (err instanceof PermanentError || err instanceof TransientError) return err;

  const status = err.statusCode || err.status || (err.response && err.response.status);
  if (status && status >= 400 && status < 500 && status !== 429) {
    return new PermanentError(err.message, err);
  }

  const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);
  if (err.code && transientCodes.has(err.code)) {
    return new TransientError(err.message, err);
  }

  if (status === 429 || (status && status >= 500)) {
    return new TransientError(err.message, err);
  }

  // Unknown errors default to transient-with-caution: bounded retries still
  // apply, so an unclassified fault degrades to reconciliation rather than
  // an infinite retry loop or a silently swallowed failure.
  return new TransientError(err.message, err);
}

/**
 * Retries `fn` with exponential backoff and jitter, bounded by `maxAttempts`.
 * Permanent errors are never retried. Options:
 *  - operation: label used for metrics/logs
 *  - maxAttempts: total attempts including the first (default 3)
 *  - baseDelayMs: base for exponential backoff (default 200ms)
 *  - maxDelayMs: cap on any single backoff delay (default 5000ms)
 */
async function retryWithBackoff(fn, options = {}) {
  const { operation = 'unknown', maxAttempts = 3, baseDelayMs = 200, maxDelayMs = 5000 } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (rawErr) {
      const err = classify(rawErr);
      lastError = err;

      if (!err.retryable) {
        logger.warn({ operation, attempt, err: err.message }, 'Permanent error, not retrying');
        throw err;
      }

      if (attempt >= maxAttempts) {
        logger.warn({ operation, attempt, err: err.message }, 'Retry attempts exhausted');
        throw err;
      }

      // Only counts as a "retry" once we've actually decided to make another
      // attempt -- a single permanent failure, or the final exhausted
      // attempt, was never retried and shouldn't inflate this counter.
      metrics.retryAttempt(operation);

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * backoff * 0.2;
      const delay = backoff + jitter;
      logger.warn({ operation, attempt, delay: Math.round(delay), err: err.message }, 'Retrying after transient error');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = { retryWithBackoff, classify, PermanentError, TransientError };
