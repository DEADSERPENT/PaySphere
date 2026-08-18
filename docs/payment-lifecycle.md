# Payment Lifecycle

## States

```
CREATED
   |
   v
PENDING
   |
   +-----------------+-----------------+-----------------+
   |                 |                 |                 |
   v                 v                 v                 v
PROCESSING       CANCELLED          EXPIRED           (SUCCEEDED / FAILED,
   |                                                    directly — see below)
   +--------+--------+
   |        |        |
   v        v        v
SUCCEEDED FAILED  EXPIRED
   |
   v
COMPLETED
```

`CANCELLED`, `FAILED`, `EXPIRED`, `COMPLETED` are **terminal**: once reached,
`domain/paymentTransitions.js` has no outgoing edge for them, and
`assertValidTransition` throws `InvalidTransitionError` for any attempt to
leave one. This is what "a payment cannot transition from a terminal state
to another incompatible terminal state" (spec section 7) actually means in
code — it isn't a runtime check bolted on, it's structurally impossible to
express.

## Why PENDING can jump straight to SUCCEEDED/FAILED

Razorpay commonly reports a final outcome (`payment.captured`,
`payment.failed`) without an intermediate "processing" webhook. Modeling
`PROCESSING` as a mandatory hop would force PaySphere to either invent a
processing event that doesn't exist, or reject legitimate webhooks that
arrive "too early" relative to an idealized diagram. `PENDING -> SUCCEEDED`
and `PENDING -> FAILED` are both explicit, valid edges for this reason.

## SUCCEEDED vs COMPLETED

These are split on purpose: `SUCCEEDED` means "the gateway confirmed the
payment," `COMPLETED` means "the local transaction record for that
confirmation is durably committed." In practice `applyGatewayOutcome`
performs both transitions inside the same database transaction, so a caller
observing a payment will only ever see `SUCCEEDED` in the narrow window
before `COMPLETED` is written milliseconds later — but keeping them as
separate, auditable steps in `payment_state_history` means "the gateway said
yes" and "we recorded it" are two independently inspectable facts, which
matters when debugging a discrepancy after the fact (spec: traceability).

## The single choke point: `applyGatewayOutcome`

Three flows can change a payment's state based on a gateway fact:

1. `POST /payments/:id/verify` — server-side verification after checkout.
2. The webhook event processor — asynchronous notification from Razorpay.
3. The reconciliation sweep — periodic repair of stuck payments.

All three call `paymentService.applyGatewayOutcome(paymentIntentId, gatewayPayment, { source, reason })`,
which, inside one transaction:

1. `SELECT ... FOR UPDATE`s the payment intent (row lock — spec section 12).
2. Maps the gateway's status to a target internal state
   (`domain/gatewayStatusMapping.js`).
3. No-ops if the intent is already terminal or already in the target state
   (duplicate webhook, repeat verify, redundant reconciliation pass — all
   harmless).
4. No-ops (with a warning log) if the transition isn't legal from the
   current state (an out-of-order/stale event).
5. Refuses to mark the payment SUCCEEDED if the gateway-reported
   amount/currency don't match the intent (spec section 7 invariant),
   recording a `MISMATCHED` attempt instead.
6. Otherwise: records a `payment_attempts` row, applies the state
   transition, creates the `transactions` row (guarded by a unique index on
   `gateway_payment_id` so the same gateway event can never produce two
   transactions), records `payment_state_history`, and — if the outcome was
   SUCCEEDED — immediately finalizes to COMPLETED.

Every branch either commits a fully consistent set of rows or the whole
transaction rolls back; there is no state where a payment's status has
changed but its transaction/attempt/history rows haven't (spec section 15).

## Idempotency claim lifecycle

`idempotency_records` rows move `IN_PROGRESS -> COMPLETED` on success, or
are deleted on failure (`release`) so a genuine retry can try again. A
crashed request that never reaches either outcome doesn't block retries
forever: after `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS` (default 30s), a later
request with the same key reclaims the row atomically (see
`idempotencyRepository.reclaimStale` — the `UPDATE ... WHERE created_at <
staleBefore` re-checks staleness at write time, so concurrent reclaim
attempts can't both win).
