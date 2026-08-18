# API

Base path: `/api/v1`. All request/response bodies are JSON.

## Authentication

Not implemented in this version — the spec treats caller authentication as
part of the "eventual production design" (section 8.1). In production,
these endpoints must sit behind platform-level authentication (mTLS, an API
key, or a signed-request scheme) before `/payments` is reachable at all.

## `POST /api/v1/payments`

Creates a payment intent and a gateway order.

**Headers**

| Header | Required | Notes |
|---|---|---|
| `Idempotency-Key` | yes | Any string up to 255 chars. Reusing a key with the same body replays the original response; reusing it with a different body returns `422`. |

**Body**

```json
{
  "orderId": "ORDER-123",
  "amount": 149900,
  "currency": "INR",
  "customerReference": "cust_42",
  "metadata": { "note": "optional, free-form" }
}
```

- `amount` is an integer in the smallest currency unit (paise for INR),
  `1 <= amount <= 1,000,000.00` in that unit.
- `currency` is one of `INR`, `USD` (see `SUPPORTED_CURRENCIES` in
  `middleware/validation.js` to extend).
- `orderId` is your platform's own order reference, max 40 chars (Razorpay's
  `receipt` field limit).

**201 Created**

```json
{
  "paymentId": "pay_...",
  "status": "PENDING",
  "gateway": "razorpay",
  "gatewayOrderId": "order_..."
}
```

**Errors**: `400` validation, `409` a concurrent request with the same key
is still in flight, `422` the key was reused with a different payload,
`5xx` the gateway order could not be created (intent is marked `FAILED`;
retry with the same key is safe — see `docs/failure-modes.md`).

## `GET /api/v1/payments/:paymentId`

```json
{
  "paymentId": "pay_...",
  "status": "COMPLETED",
  "externalOrderId": "ORDER-123",
  "amount": 149900,
  "currency": "INR",
  "createdAt": "...",
  "updatedAt": "...",
  "gateway": "razorpay",
  "orders": [{ "gatewayOrderId": "order_...", "status": "paid" }],
  "transactions": [
    { "transactionId": "txn_...", "gatewayPaymentId": "pay_...", "amount": 149900, "currency": "INR", "status": "CAPTURED", "createdAt": "..." }
  ],
  "history": [
    { "fromState": null, "toState": "CREATED", "reason": "...", "source": "system", "createdAt": "..." }
  ]
}
```

`404` if the payment doesn't exist.

## `POST /api/v1/payments/:paymentId/verify`

Server-side verification after the client-side checkout flow completes.
**Never trust the client's own success/failure claim** — this endpoint
cryptographically verifies the checkout signature and then independently
fetches the payment from the gateway; the response reflects the gateway's
answer, not anything the caller asserted.

```json
{
  "gatewayOrderId": "order_...",
  "gatewayPaymentId": "pay_...",
  "signature": "..."
}
```

**200 OK** — returns the payment in its (possibly unchanged) current state.
**422** `VERIFICATION_FAILED` if the signature doesn't check out, or if the
`gatewayOrderId`/`gatewayPaymentId` don't belong together or don't belong to
this payment.

## `POST /api/v1/webhooks/razorpay`

Configure this URL in the Razorpay dashboard. Requires the raw request body
(signature is an HMAC over the exact bytes received) — see
`express.json({ verify })` in `server.js`.

**Headers**: `x-razorpay-signature` (required).

**200 OK** always, with one of:

```json
{ "status": "PROCESSED" }
{ "status": "DUPLICATE" }
```

`401` if the signature doesn't verify (request rejected before any DB
write). A `5xx` means the event was persisted but processing failed
(malformed payload, DB error); Razorpay's own retry policy will redeliver
it, and it's also durably queryable via `webhook_events.status = 'FAILED'`.

Handled event types: `payment.authorized`, `payment.captured`,
`payment.failed`. Anything else is acknowledged and persisted but marked
`IGNORED` — it does not affect payment state.

## Operational endpoints

- `GET /health` — liveness check, no auth, no DB dependency.
- `GET /metrics` — Prometheus text-format counters/histograms (spec section 19).

## Errors

Every error response has the shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

5xx responses never include the underlying stack trace or internal error
message (spec section 18) — only 4xx responses (client-actionable) include
a specific message.
