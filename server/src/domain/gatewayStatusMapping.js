const { STATES } = require('./paymentStates');

/**
 * Maps a normalized gateway payment status (see razorpayAdapter's
 * RAZORPAY_TO_INTERNAL_PAYMENT_STATUS) onto the internal payment lifecycle
 * state it represents. CREATED has no entry: an order existing at the
 * gateway with no payment attempt yet carries no state-machine action.
 * REFUNDED has no entry: refunds are out of scope for the state machine
 * until introduced (spec sections 3, 8.3).
 */
const GATEWAY_STATUS_TO_STATE = Object.freeze({
  AUTHORIZED: STATES.PROCESSING,
  CAPTURED: STATES.SUCCEEDED,
  FAILED: STATES.FAILED,
});

module.exports = { GATEWAY_STATUS_TO_STATE };
