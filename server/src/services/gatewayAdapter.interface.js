/**
 * Stable gateway abstraction (spec section 8.3). Every adapter — Razorpay,
 * the in-memory mock used in dev/tests, or a future gateway — implements
 * this exact shape so paymentService/webhookService/reconciliationService
 * never contain gateway-specific branching.
 *
 * Implementations must expose:
 *
 *   name: string
 *
 *   async createOrder({ amount, currency, receipt, notes }) ->
 *     { gatewayOrderId, status, raw }
 *
 *   async fetchOrder(gatewayOrderId) ->
 *     { gatewayOrderId, status, amountPaid, raw }
 *
 *   async fetchPaymentsForOrder(gatewayOrderId) ->
 *     Array<{ gatewayPaymentId, gatewayOrderId, status, amount, currency, raw }>
 *     Used by the reconciliation service to see every attempt the gateway
 *     has recorded against an order (spec section 8.6, 17).
 *
 *   async fetchPayment(gatewayPaymentId) ->
 *     { gatewayPaymentId, gatewayOrderId, status, amount, currency, raw }
 *
 *   verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature }) -> boolean
 *     Synchronous, local HMAC check used by the /verify endpoint. Never
 *     trusts the client beyond this cryptographic check — the caller must
 *     still fetch the payment from the gateway for authoritative status.
 *
 *   verifyWebhookSignature({ rawBody, signature }) -> boolean
 *     Synchronous, local HMAC check used by the webhook endpoint before any
 *     state mutation (spec section 14 "Invalid webhook signature").
 *
 *   async refund(gatewayPaymentId, amount) -> never (throws NotImplementedError)
 *     Placeholder until refunds are introduced (spec section 8.3).
 */

class NotImplementedError extends Error {
  constructor(operation) {
    super(`${operation} is not implemented by this gateway adapter`);
    this.name = 'NotImplementedError';
    this.statusCode = 501;
  }
}

module.exports = { NotImplementedError };
