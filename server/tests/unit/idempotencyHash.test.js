const { hashRequest } = require('../../src/middleware/idempotency');

describe('idempotency request hashing', () => {
  test('produces the same hash regardless of key order', () => {
    const a = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    const b = hashRequest({ currency: 'INR', amount: 1000, orderId: 'ORDER-1' });
    expect(a).toBe(b);
  });

  test('is case-insensitive on currency', () => {
    const a = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'inr' });
    const b = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    expect(a).toBe(b);
  });

  test('differs when amount changes', () => {
    const a = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    const b = hashRequest({ orderId: 'ORDER-1', amount: 2000, currency: 'INR' });
    expect(a).not.toBe(b);
  });

  test('differs when orderId changes', () => {
    const a = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    const b = hashRequest({ orderId: 'ORDER-2', amount: 1000, currency: 'INR' });
    expect(a).not.toBe(b);
  });

  test('ignores unrelated extra fields', () => {
    const a = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR' });
    const b = hashRequest({ orderId: 'ORDER-1', amount: 1000, currency: 'INR', metadata: { note: 'x' } });
    expect(a).toBe(b);
  });
});
