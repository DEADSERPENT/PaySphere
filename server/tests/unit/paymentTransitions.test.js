const { STATES } = require('../../src/domain/paymentStates');
const { canTransition, assertValidTransition, InvalidTransitionError } = require('../../src/domain/paymentTransitions');

describe('payment state transitions', () => {
  test.each([
    [STATES.CREATED, STATES.PENDING],
    [STATES.PENDING, STATES.PROCESSING],
    [STATES.PENDING, STATES.CANCELLED],
    [STATES.PENDING, STATES.EXPIRED],
    [STATES.PENDING, STATES.SUCCEEDED],
    [STATES.PENDING, STATES.FAILED],
    [STATES.PROCESSING, STATES.SUCCEEDED],
    [STATES.PROCESSING, STATES.FAILED],
    [STATES.PROCESSING, STATES.EXPIRED],
    [STATES.SUCCEEDED, STATES.COMPLETED],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertValidTransition(from, to)).not.toThrow();
  });

  test.each([
    [STATES.CREATED, STATES.SUCCEEDED],
    [STATES.PENDING, STATES.COMPLETED],
    [STATES.PROCESSING, STATES.CANCELLED],
    [STATES.SUCCEEDED, STATES.FAILED],
    [STATES.FAILED, STATES.SUCCEEDED],
    [STATES.CANCELLED, STATES.PENDING],
    [STATES.EXPIRED, STATES.PROCESSING],
    [STATES.COMPLETED, STATES.PENDING],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertValidTransition(from, to)).toThrow(InvalidTransitionError);
  });

  test('rejects self-transition', () => {
    expect(canTransition(STATES.PENDING, STATES.PENDING)).toBe(false);
  });

  test.each([STATES.CANCELLED, STATES.FAILED, STATES.EXPIRED, STATES.COMPLETED])(
    'terminal state %s has no outgoing transitions',
    (terminal) => {
      for (const target of Object.values(STATES)) {
        if (target === terminal) continue;
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  );

  test('rejects transitioning to an unknown state', () => {
    expect(() => assertValidTransition(STATES.PENDING, 'NOT_A_STATE')).toThrow(/Unknown target payment state/);
  });
});
