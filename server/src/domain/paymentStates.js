/**
 * The full payment lifecycle (spec section 6).
 *
 *   CREATED -> PENDING -> PROCESSING -> SUCCEEDED -> COMPLETED
 *                      \-> CANCELLED      \-> FAILED
 *                      \-> EXPIRED        \-> EXPIRED
 *
 * CANCELLED, FAILED, EXPIRED and COMPLETED are terminal: once reached, no
 * further transition is permitted (invariant, spec section 7).
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

const TERMINAL_STATES = new Set([STATES.CANCELLED, STATES.FAILED, STATES.EXPIRED, STATES.COMPLETED]);

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

module.exports = { STATES, TERMINAL_STATES, isTerminal };
