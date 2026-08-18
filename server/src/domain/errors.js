class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class IdempotencyKeyConflictError extends AppError {
  constructor(message) {
    super(message, 422, 'IDEMPOTENCY_KEY_CONFLICT');
    this.name = 'IdempotencyKeyConflictError';
  }
}

class IdempotencyInProgressError extends AppError {
  constructor(message) {
    super(message, 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
    this.name = 'IdempotencyInProgressError';
  }
}

class UnauthorizedWebhookError extends AppError {
  constructor(message) {
    super(message, 401, 'INVALID_WEBHOOK_SIGNATURE');
    this.name = 'UnauthorizedWebhookError';
  }
}

class VerificationFailedError extends AppError {
  constructor(message) {
    super(message, 422, 'VERIFICATION_FAILED');
    this.name = 'VerificationFailedError';
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  IdempotencyKeyConflictError,
  IdempotencyInProgressError,
  UnauthorizedWebhookError,
  VerificationFailedError,
};
