# PaySphere

**Distributed Payment Orchestration System**

PaySphere is a payment orchestration backend: it sits between an external
platform and a payment gateway (Razorpay), owning idempotency, an explicit
payment state machine, webhook deduplication, and reconciliation — so
callers get a stable, gateway-agnostic API instead of talking to Razorpay
directly. See `PaySphere_Complete_System_Design_Document.docx` for the full
spec and `docs/` for the implementation notes.

## Quick start

```bash
docker compose up -d              # PostgreSQL (paysphere + paysphere_test)
cp .env.example .env              # defaults use GATEWAY_ADAPTER=mock

cd server
npm install
npm run migrate
npm run dev                       # -> http://localhost:3000/health
npm run worker                    # in another terminal: reconciliation loop
```

Try the demo checkout at `http://localhost:3000/`, or call the API directly:

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"orderId":"ORDER-1","amount":149900,"currency":"INR"}'
```

`GATEWAY_ADAPTER=mock` uses an in-memory stand-in (no Razorpay account
needed, and what tests always use); `razorpay` hits the real test-mode API.

## Tests

```bash
cd server
npm test                                # everything
npm run test:unit                       # no DB required
npm run test:integration                # requires TEST_DATABASE_URL
npm run test:failure                    # timeouts, crashes, races, duplicates
npm run loadtest -- --concurrency 100   # concurrency/throughput check
```

See `docs/failure-modes.md` for how each spec failure scenario is tested.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — components and gateway isolation
- [`docs/payment-lifecycle.md`](docs/payment-lifecycle.md) — the state machine
- [`docs/failure-modes.md`](docs/failure-modes.md) — failure scenarios and tests
- [`docs/api.md`](docs/api.md) — API reference

## Security notes

- No card numbers, CVVs, or UPI PINs are ever stored — only gateway-issued references.
- Webhook signatures are verified over the raw request body before any database write.
- In production: run behind TLS with `NODE_ENV=production`, use a
  least-privilege DB role, and rotate `RAZORPAY_KEY_SECRET`/
  `RAZORPAY_WEBHOOK_SECRET` per policy (spec section 18,
  `docs/failure-modes.md`).
