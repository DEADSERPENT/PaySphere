/**
 * The full payment lifecycle (spec section 6).
 *
 *   CREATED -> PENDING -> PROCESSING -> SUCCEEDED -> COMPLETED
 *                      \-> CANCELLED      \-> FAILED -> SUCCEEDED
 *                      \-> EXPIRED        \-> EXPIRED
 *
 * CANCELLED, EXPIRED and COMPLETED are terminal: once reached, no further
 * transition is permitted (invariant, spec section 7). FAILED is a
 * deliberate exception: Razorpay's Standard Checkout lets a customer retry
 * with a different payment method after a decline without opening a new
 * order, so a `payment.failed` webhook for one attempt does not mean the
 * order is dead — a later `payment.captured` for a subsequent attempt on
 * the same order must still be able to win. See
 * `domain/paymentTransitions.js` for the one FAILED -> SUCCEEDED edge this
 * requires.
 */
const STATES = Object.freeze({
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  COMPLETED: 'COMPLETED',
});

const TERMINAL_STATES = new Set([STATES.CANCELLED, STATES.EXPIRED, STATES.COMPLETED]);

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

module.exports = { STATES, TERMINAL_STATES, isTerminal };
