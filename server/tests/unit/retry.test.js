const { retryWithBackoff, classify, PermanentError, TransientError } = require('../../src/lib/retry');

describe('error classification', () => {
  test('classifies 4xx (except 429) as permanent', () => {
    const err = Object.assign(new Error('bad request'), { statusCode: 400 });
    expect(classify(err)).toBeInstanceOf(PermanentError);
  });

  test('classifies 429 as transient', () => {
    const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
    expect(classify(err)).toBeInstanceOf(TransientError);
  });

  test('classifies 5xx as transient', () => {
    const err = Object.assign(new Error('server error'), { statusCode: 503 });
    expect(classify(err)).toBeInstanceOf(TransientError);
  });

  test('classifies network error codes as transient', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classify(err)).toBeInstanceOf(TransientError);
  });

  test('classifies an already-classified PermanentError as-is', () => {
    const err = new PermanentError('nope');
    expect(classify(err)).toBe(err);
  });
});

describe('retryWithBackoff', () => {
  test('returns the result on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { operation: 'test', maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries transient failures up to maxAttempts then succeeds', async () => {
    const err = Object.assign(new Error('timeout'), { statusCode: 503 });
    const fn = jest.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { operation: 'test', maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('does not retry permanent errors', async () => {
    const err = Object.assign(new Error('validation'), { statusCode: 400 });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { operation: 'test', maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      'validation'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('gives up after exhausting attempts on persistent transient failures', async () => {
    const err = Object.assign(new Error('down'), { statusCode: 503 });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { operation: 'test', maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
