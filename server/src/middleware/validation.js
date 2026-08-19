const { ValidationError } = require('../domain/errors');

const SUPPORTED_CURRENCIES = new Set(['INR', 'USD']);

// Razorpay's `receipt` field (which orderId is passed through as) is capped
// at 40 characters; enforcing it here gives a clear 400 instead of a
// confusing gateway-side rejection later. MAX_AMOUNT is a defensive upper
// bound against fat-fingered or malicious multi-order-of-magnitude amounts
// (spec section 18: validate and constrain all input).
const ORDER_ID_MAX_LENGTH = 40;
const MIN_AMOUNT = 100; // Razorpay's real order minimum is 100 paise (INR 1.00)
const MAX_AMOUNT = 10_00_00_000; // 1,000,000.00 in the smallest currency unit

function validateCreatePayment(req, res, next) {
  const { orderId, amount, currency } = req.body || {};

  if (!orderId || typeof orderId !== 'string') {
    return next(new ValidationError('orderId is required and must be a string'));
  }
  if (orderId.length > ORDER_ID_MAX_LENGTH) {
    return next(new ValidationError(`orderId must be at most ${ORDER_ID_MAX_LENGTH} characters`));
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return next(new ValidationError('amount is required, must be an integer in the smallest currency unit, and must be positive'));
  }
  if (amount < MIN_AMOUNT) {
    return next(new ValidationError(`amount must be at least ${MIN_AMOUNT} (Razorpay's minimum order amount)`));
  }
  if (amount > MAX_AMOUNT) {
    return next(new ValidationError(`amount exceeds the maximum allowed value of ${MAX_AMOUNT}`));
  }
  if (!currency || typeof currency !== 'string' || !SUPPORTED_CURRENCIES.has(currency.toUpperCase())) {
    return next(new ValidationError(`currency is required and must be one of: ${[...SUPPORTED_CURRENCIES].join(', ')}`));
  }
  if (req.body.metadata !== undefined && (typeof req.body.metadata !== 'object' || Array.isArray(req.body.metadata))) {
    return next(new ValidationError('metadata must be an object when provided'));
  }

  next();
}

function validateVerifyPayment(req, res, next) {
  const { gatewayOrderId, gatewayPaymentId, signature } = req.body || {};
  if (!gatewayOrderId || typeof gatewayOrderId !== 'string') {
    return next(new ValidationError('gatewayOrderId is required'));
  }
  if (!gatewayPaymentId || typeof gatewayPaymentId !== 'string') {
    return next(new ValidationError('gatewayPaymentId is required'));
  }
  if (!signature || typeof signature !== 'string') {
    return next(new ValidationError('signature is required'));
  }
  next();
}

// All fields optional and best-effort: this only records an audit trail
// entry for a client-reported failure, so it should accept whatever shape
// the gateway's client-side error object happens to have rather than
// rejecting a report because a field the caller didn't have is missing.
function validateReportFailure(req, res, next) {
  const { code, description, gatewayPaymentId } = req.body || {};
  if (code !== undefined && typeof code !== 'string') {
    return next(new ValidationError('code must be a string when provided'));
  }
  if (description !== undefined && typeof description !== 'string') {
    return next(new ValidationError('description must be a string when provided'));
  }
  if (gatewayPaymentId !== undefined && typeof gatewayPaymentId !== 'string') {
    return next(new ValidationError('gatewayPaymentId must be a string when provided'));
  }
  next();
}

function requireIdempotencyKey(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return next(new ValidationError('Idempotency-Key header is required'));
  }
  if (key.length > 255) {
    return next(new ValidationError('Idempotency-Key must be at most 255 characters'));
  }
  next();
}

module.exports = {
  validateCreatePayment,
  validateVerifyPayment,
  validateReportFailure,
  requireIdempotencyKey,
  SUPPORTED_CURRENCIES,
};
