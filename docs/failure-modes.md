# Failure Modes

For each failure scenario in the spec (section 14), what PaySphere actually
does and where that's implemented/tested.

| Scenario | What happens | Where |
|---|---|---|
| **Client timeout** — caller doesn't know if create-payment succeeded | Retry with the same `Idempotency-Key` replays the original response; a `GET` is always safe | `middleware/idempotency.js`; `tests/integration/createPayment.test.js` |
| **Gateway timeout on order creation** | `gatewayService` retries transient failures (network errors, 5xx, 429) with exponential backoff (max 3 attempts); if still failing, the intent is moved to `FAILED` (never left stuck `PENDING`) and the idempotency claim is released so a fresh retry is possible | `lib/retry.js`, `services/paymentService.js`; `tests/failure-injection/gatewayTimeout.test.js` |
| **Gateway order created but the local DB write fails** | The local write (`payment_orders` insert) is retried; if it still fails, the intent is explicitly failed rather than left as an orphaned `PENDING` with no order row (which reconciliation could never find) | `services/paymentService.js` (`createPayment`) |
| **Payment succeeds but the client loses the response** | The webhook (and/or reconciliation) independently establishes the authoritative state — the client's HTTP response was never the source of truth | `services/webhookService.js`, `services/reconciliationService.js` |
| **Duplicate webhook** | `UNIQUE (gateway, gateway_event_id)` makes the second delivery a no-op at the DB level; the handler returns `DUPLICATE` without reprocessing | `repositories/webhookRepository.js`; `tests/integration/webhook.test.js`, `tests/failure-injection/duplicateWebhookRace.test.js` |
| **Webhook out of order** | `applyGatewayOutcome` checks the current state before applying a transition: a stale event for an already-terminal or already-current-state payment is a harmless no-op, not an error and not a regression | `services/paymentService.js`; `tests/failure-injection/outOfOrderWebhook.test.js` |
| **Invalid webhook signature** | Rejected with 401 *before* the payload is parsed or persisted — no state mutation, no DB write at all | `services/webhookService.js`; `tests/integration/webhook.test.js` |
| **Database failure mid-write** | Every multi-statement operation runs inside `db.withTransaction`; any thrown error rolls back the whole transaction, so a partial payment_intents-row-with-no-history (or similar) can never be observed | `config/database.js`; `tests/failure-injection/dbFailureSimulation.test.js` |
| **Worker crash mid webhook-processing** | The event is already durably persisted (status `RECEIVED`) before processing starts; a crash leaves it `FAILED` (via the catch block) or `RECEIVED`, both of which `webhookRepository.findPendingForRetry` picks up. Reprocessing is safe because `applyGatewayOutcome` is idempotent | `services/webhookService.js`; `tests/failure-injection/workerCrashSimulation.test.js` |
| **Two workers process one payment concurrently** | `SELECT ... FOR UPDATE` inside `applyGatewayOutcome` serializes concurrent attempts on the same intent; the loser observes the already-applied state and no-ops | `repositories/paymentRepository.js` (`lockIntentById`); `tests/failure-injection/duplicateWebhookRace.test.js` |
| **Gateway says success, local state still pending** | The reconciliation sweep finds it (stuck beyond the configured timeout), asks the gateway directly, and finalizes it via the same `applyGatewayOutcome` path | `services/reconciliationService.js`; `tests/integration/reconciliation.test.js` |
| **Local state success, gateway later disagrees** | Not applicable to a genuine gateway state (a captured payment is captured); this instead protects against a *forged or malformed* client-asserted success — verification always re-fetches from the gateway rather than trusting the caller | `services/paymentService.js` (`verifyPayment`); `tests/integration/verifyPayment.test.js` |
| **Two create-payment requests, same idempotency key, concurrent** | `UNIQUE (scope, idempotency_key)` means only one `INSERT` can win; the loser observes the winner's `IN_PROGRESS`/`COMPLETED` record instead of racing it | `repositories/idempotencyRepository.js`; `tests/failure-injection/concurrentIdempotentRequests.test.js` |
| **Crashed request holding an idempotency claim forever** | Not in the original spec table, but the same "worker crash" class of problem: an `IN_PROGRESS` claim older than `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS` is reclaimable, so a crash doesn't permanently lock out retries with that key | `repositories/idempotencyRepository.js` (`reclaimStale`); `tests/failure-injection/staleIdempotencyClaim.test.js` |

## What's deliberately *not* handled yet

- **Refunds** — `refund()` throws `NotImplementedError` on both adapters.
  Out of scope until introduced (spec section 3).
- **Manual-capture flows** (`AUTHORIZED` sitting indefinitely without a
  capture) — reconciliation reports these as `UNKNOWN` and leaves them
  alone rather than guessing; a human or a future capture-timeout policy
  resolves them.
- **True asynchronous webhook processing** (queue + worker pool) — V1/V2
  process webhooks synchronously within the request. `paymentWorker.js`
  already runs reconciliation as a separate process, but webhook processing
  moving off the request thread is explicitly a V3 concern (spec section 5)
  to be introduced only once there's a concrete throughput/coordination need.
