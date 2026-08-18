const { validateCreatePayment, validateVerifyPayment, requireIdempotencyKey } = require('../../src/middleware/validation');
const { ValidationError } = require('../../src/domain/errors');

function mockReq(body = {}, headers = {}) {
  return { body, header: (name) => headers[name] };
}

function runMiddleware(mw, req) {
  let calledWith;
  const next = (err) => {
    calledWith = err;
  };
  mw(req, {}, next);
  return calledWith;
}

describe('validateCreatePayment', () => {
  test('accepts a valid payload', () => {
    const req = mockReq({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    expect(runMiddleware(validateCreatePayment, req)).toBeUndefined();
  });

  test('rejects missing orderId', () => {
    const req = mockReq({ amount: 1000, currency: 'INR' });
    expect(runMiddleware(validateCreatePayment, req)).toBeInstanceOf(ValidationError);
  });

  test('rejects zero or negative amount', () => {
    expect(runMiddleware(validateCreatePayment, mockReq({ orderId: 'O', amount: 0, currency: 'INR' }))).toBeInstanceOf(
      ValidationError
    );
    expect(
      runMiddleware(validateCreatePayment, mockReq({ orderId: 'O', amount: -500, currency: 'INR' }))
    ).toBeInstanceOf(ValidationError);
  });

  test('rejects non-integer amount', () => {
    const req = mockReq({ orderId: 'O', amount: 100.5, currency: 'INR' });
    expect(runMiddleware(validateCreatePayment, req)).toBeInstanceOf(ValidationError);
  });

  test('rejects unsupported currency', () => {
    const req = mockReq({ orderId: 'O', amount: 1000, currency: 'ZZZ' });
    expect(runMiddleware(validateCreatePayment, req)).toBeInstanceOf(ValidationError);
  });

  test('rejects non-object metadata', () => {
    const req = mockReq({ orderId: 'O', amount: 1000, currency: 'INR', metadata: 'nope' });
    expect(runMiddleware(validateCreatePayment, req)).toBeInstanceOf(ValidationError);
  });
});

describe('validateVerifyPayment', () => {
  test('accepts a valid payload', () => {
    const req = mockReq({ gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature: 'sig' });
    expect(runMiddleware(validateVerifyPayment, req)).toBeUndefined();
  });

  test.each(['gatewayOrderId', 'gatewayPaymentId', 'signature'])('rejects missing %s', (field) => {
    const body = { gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature: 'sig' };
    delete body[field];
    expect(runMiddleware(validateVerifyPayment, mockReq(body))).toBeInstanceOf(ValidationError);
  });
});

describe('requireIdempotencyKey', () => {
  test('accepts a present key', () => {
    const req = mockReq({}, { 'Idempotency-Key': 'abc123' });
    expect(runMiddleware(requireIdempotencyKey, req)).toBeUndefined();
  });

  test('rejects a missing key', () => {
    const req = mockReq({}, {});
    expect(runMiddleware(requireIdempotencyKey, req)).toBeInstanceOf(ValidationError);
  });

  test('rejects an overly long key', () => {
    const req = mockReq({}, { 'Idempotency-Key': 'x'.repeat(300) });
    expect(runMiddleware(requireIdempotencyKey, req)).toBeInstanceOf(ValidationError);
  });
});
