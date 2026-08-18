# Architecture

## What PaySphere is

PaySphere is a payment **orchestration backend**, not a payment processor and
not a UI. An external platform (commerce, booking, SaaS, marketplace) asks
PaySphere to create and manage a payment. PaySphere coordinates its own
durable state with a payment gateway — Razorpay in this implementation — and
exposes a stable, gateway-agnostic API to the calling platform.

Razorpay is the payment rail. PaySphere is the reliability layer around it:
idempotency, state-machine correctness, webhook deduplication, transactional
consistency, retries, and reconciliation.

## High-level shape

```
External Platform
      | Create / Query / Verify Payment
      v
+-----------------------------+
| PaySphere Payment API       |
|  - Validation                |
|  - Idempotency                |
|  - Payment Service            |
|  - State Machine              |
+---------------+--------------+
                |
        +-------+--------+
        |                |
        v                v
   PostgreSQL      Gateway Adapter --- Razorpay
        ^                |
        |                v
        |         Webhook Service
        |                |
        |                v
        |         Event Processor
        |                |
        |                v
        +---------- Reconciliation
                          |
                          v
                     PostgreSQL
```

## Modular monolith, not microservices

Everything above runs in one Node.js process (`server/src/server.js`) talking
to one PostgreSQL database. There is no message queue and no separate
service boundary between the API, webhook handling, and reconciliation.

This is deliberate (spec section 3/5): starting with microservices "for
appearance" adds distributed-systems failure modes (partial deploys, network
partitions between *our own* services) without adding correctness. The
reliability problems PaySphere exists to solve — duplicate requests, lost
responses, duplicate webhooks, worker crashes, gateway/local state
divergence — are all present and worth solving inside a single well-tested
process first. Redis/a queue/multiple workers (V3) are only introduced once
a concrete scalability or coordination need appears; `paymentWorker.js`
already runs as a separate OS process from the API server so that
reconciliation load can be scaled or moved independently later without a
rewrite.

## Components

| Component | File(s) | Responsibility |
|---|---|---|
| Payment API | `routes/paymentRoutes.js`, `controllers/paymentController.js` | HTTP surface: validation, idempotency enforcement, response shaping |
| Payment Service | `services/paymentService.js` | Owns the payment lifecycle: intent creation, the single `applyGatewayOutcome` choke point every state-changing gateway fact funnels through |
| Gateway Adapter | `services/gatewayAdapter.interface.js`, `services/razorpayAdapter.js`, `services/mockGatewayAdapter.js`, `services/gatewayService.js` | Stable interface (`createOrder`, `fetchPayment`, `fetchPaymentsForOrder`, `verifyPaymentSignature`, `verifyWebhookSignature`, `refund`) with all Razorpay SDK knowledge behind it |
| Webhook Service / Event Processor | `services/webhookService.js`, `controllers/webhookController.js` | Verifies signature, persists + deduplicates events, applies them to the state machine |
| Reconciliation Service | `services/reconciliationService.js`, `workers/paymentWorker.js` | Periodically repairs payments stuck in PENDING/PROCESSING by asking the gateway for the authoritative outcome |
| Domain | `domain/paymentStates.js`, `domain/paymentTransitions.js`, `domain/gatewayStatusMapping.js`, `domain/errors.js` | The state machine and its invariants, independent of HTTP/DB/gateway concerns |
| Repositories | `repositories/*.js` | All SQL. Every function accepts an optional transaction client so callers control atomicity |
| PostgreSQL | `migrations/*.sql`, `config/database.js` | The durable consistency boundary — see `docs/payment-lifecycle.md` for the schema |

## Why one function owns every state transition

`paymentService.applyGatewayOutcome()` is called from three places: the
`/verify` endpoint (server-side verification), the webhook event processor,
and the reconciliation service. All three are really the same operation —
"here is a fact from the gateway about a payment, apply it" — and the
invariants in spec section 7 (no double transactions, no terminal-state
regression, atomicity) only need to be enforced correctly once instead of
three times with three chances to drift out of sync.

## Gateway isolation

Nothing outside `services/razorpayAdapter.js` imports the `razorpay`
package. `services/gatewayService.js` is what the rest of the codebase
depends on; it selects between `RazorpayAdapter` and `MockGatewayAdapter`
based on `GATEWAY_ADAPTER` and wraps every network-calling method with retry
+ latency instrumentation. Swapping gateways, or adding a second one, means
writing one new adapter file — no changes to payment/webhook/reconciliation
logic.
