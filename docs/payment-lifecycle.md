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
   |        |
   v        v
COMPLETED SUCCEEDED (see "Why FAILED can still become SUCCEEDED" below)
```

`CANCELLED`, `EXPIRED`, `COMPLETED` are **terminal**: once reached,
`domain/paymentTransitions.js` has no outgoing edge for them, and
`assertValidTransition` throws `InvalidTransitionError` for any attempt to
leave one. This is what "a payment cannot transition from a terminal state
to another incompatible terminal state" (spec section 7) actually means in
code — it isn't a runtime check bolted on, it's structurally impossible to
express.

`FAILED` is a deliberate exception to that, with exactly one outgoing edge:
`FAILED -> SUCCEEDED`. See below.

## Why FAILED can still become SUCCEEDED

Razorpay's Standard Checkout lets a customer retry with a different payment
method after a decline, without PaySphere ever seeing a new order — the
retry reuses the same `gatewayOrderId`, so a `payment.failed` webhook for
one attempt and a `payment.captured` webhook for a later attempt can both
arrive for the *same* payment intent, in either order.

`reconciliationService.pickAuthoritativeOutcome` already encodes the correct
priority for this — a capture always outranks a failure when reconciling a
stuck payment against gateway-side truth — but that only covers intents
reconciliation still considers stuck (`PENDING`/`PROCESSING`). Before this
edge existed, a `payment.failed` arriving *before* the retry's
`payment.captured` would move the intent straight to a fully terminal
`FAILED`, and the later, authoritative capture would be silently dropped as
"already terminal" — even though `outOfOrderWebhook.test.js` already proved
the reverse ordering (captured-then-failed) resolves correctly. The
`FAILED -> SUCCEEDED` edge makes both orderings converge on the same
correct outcome: capture wins, regardless of delivery order. A second,
genuinely final failure (no capture ever arrives) is still resolved the
same way it always was — reconciliation's stuck-payment sweep.

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
