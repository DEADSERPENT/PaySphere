const { STATES, isTerminal } = require('./paymentStates');

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid payment state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.statusCode = 409;
  }
}

/**
 * Explicit transition table (spec section 6/7). Every entry here is a
 * deliberate design decision, not an arbitrary string update:
 *
 *  - CREATED is a transient bookkeeping state the intent occupies only
 *    between being inserted and immediately moved to PENDING in the same
 *    transaction, so it appears here purely for completeness.
 *  - PENDING can resolve straight to SUCCEEDED/FAILED (Razorpay commonly
 *    reports a final outcome without a separate "processing" webhook) as
 *    well as via PROCESSING, or be explicitly CANCELLED, or EXPIRE if the
 *    customer never completes the attempt.
 *  - PROCESSING (an attempt is underway) resolves to SUCCEEDED, FAILED, or
 *    EXPIRED if the gateway never responds within the allowed window.
 *  - SUCCEEDED always finalizes into COMPLETED once the local transaction
 *    record has been created — SUCCEEDED and COMPLETED are split so
 *    "gateway confirmed" and "local bookkeeping settled" remain auditable
 *    as distinct facts.
 *  - FAILED has exactly one outgoing edge, to SUCCEEDED: Razorpay Standard
 *    Checkout permits retrying with a different payment method against the
 *    same order after a decline, so a `payment.failed` webhook for one
 *    attempt must not permanently block a `payment.captured` webhook for a
 *    later attempt on that same order from winning (this mirrors the
 *    capture-beats-failure priority `reconciliationService.pickAuthoritativeOutcome`
 *    already applies when repairing stuck payments).
 *  - CANCELLED, EXPIRED, COMPLETED are terminal: no outgoing edges.
 */
const TRANSITIONS = Object.freeze({
  [STATES.CREATED]: new Set([STATES.PENDING]),
  [STATES.PENDING]: new Set([
    STATES.PROCESSING,
    STATES.CANCELLED,
    STATES.EXPIRED,
    STATES.SUCCEEDED,
    STATES.FAILED,
  ]),
  [STATES.PROCESSING]: new Set([STATES.SUCCEEDED, STATES.FAILED, STATES.EXPIRED]),
  [STATES.SUCCEEDED]: new Set([STATES.COMPLETED]),
  [STATES.FAILED]: new Set([STATES.SUCCEEDED]),
  [STATES.CANCELLED]: new Set(),
  [STATES.EXPIRED]: new Set(),
  [STATES.COMPLETED]: new Set(),
});

/** Returns true if `from -> to` is a legal transition; false otherwise. */
function canTransition(from, to) {
  if (from === to) return false;
  const allowed = TRANSITIONS[from];
  return Boolean(allowed && allowed.has(to));
}

/**
 * Throws InvalidTransitionError unless `from -> to` is legal. Terminal
 * states never have outgoing entries in TRANSITIONS, so this also enforces
 * the "no terminal-to-incompatible-terminal" invariant for free.
 */
function assertValidTransition(from, to) {
  if (!STATES[to]) {
    throw new Error(`Unknown target payment state: ${to}`);
  }
  if (isTerminal(from)) {
    throw new InvalidTransitionError(from, to);
  }
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

module.exports = { TRANSITIONS, canTransition, assertValidTransition, InvalidTransitionError };
