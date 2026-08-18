const logger = require('../lib/logger');
const { AppError } = require('../domain/errors');
const { InvalidTransitionError } = require('../domain/paymentTransitions');

/**
 * Central error handler. Always returns a structured error body and never
 * leaks stack traces or internal details to the caller (spec section 18).
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isKnown = err instanceof AppError || err instanceof InvalidTransitionError;
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
  } else {
    logger.warn({ err: err.message, code: err.code }, 'Request failed');
  }

  res.status(statusCode).json({
    error: {
      code: err.code || (isKnown ? err.name : 'INTERNAL_ERROR'),
      message: isKnown || statusCode < 500 ? err.message : 'An internal error occurred',
    },
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` } });
}

/** Wraps an async route handler so rejected promises reach errorHandler instead of crashing the process. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, notFoundHandler, asyncHandler };
