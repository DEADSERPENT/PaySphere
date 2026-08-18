# PaySphere

**Distributed Payment Orchestration System**

PaySphere is a payment orchestration *backend*. An external platform
(commerce, booking, SaaS, marketplace) asks PaySphere to create and manage a
payment; PaySphere coordinates its own durable state with a payment gateway
(Razorpay) and exposes a stable, gateway-agnostic API back to the platform.

It is not a banking dashboard, a wallet, or a consumer finance UI, and it
does not replace Razorpay — it's the reliability layer around it:
idempotency, explicit payment state machine, transactional consistency,
webhook deduplication, retries, and reconciliation. See
`PaySphere_Complete_System_Design_Document.docx` for the full spec this
implementation follows, and `docs/` for how it's actually built.

## Quick start

```bash
# 1. Bring up PostgreSQL (paysphere + paysphere_test databases)
docker compose up -d

# 2. Configure environment
cp .env.example .env   # defaults use GATEWAY_ADAPTER=mock, no real Razorpay account needed

# 3. Install dependencies and run migrations
cd server
npm install
npm run migrate

# 4. Run the server
npm run dev
# -> http://localhost:3000/health

# 5. In another terminal, run reconciliation on an interval
npm run worker
```

### Try it

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"orderId":"ORDER-1","amount":149900,"currency":"INR"}'
```

With `GATEWAY_ADAPTER=mock` (the default), no real Razorpay credentials are
needed for local development — `services/mockGatewayAdapter.js` is a
deterministic in-memory stand-in with the same interface as the real
adapter. Switch to `GATEWAY_ADAPTER=razorpay` and fill in `RAZORPAY_KEY_ID` /
`RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` in `.env` to use Razorpay
test mode.

## Tests

```bash
cd server
npm test              # everything
npm run test:unit            # no DB required
npm run test:integration     # requires TEST_DATABASE_URL
npm run test:failure         # failure-injection: timeouts, crashes, races, duplicates
npm run loadtest -- --concurrency 100   # simple concurrency/throughput check against a running server
```

97 tests across unit, integration, and failure-injection suites — see
`docs/failure-modes.md` for what each failure scenario in the spec maps to
and where it's tested.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — components, why a
  modular monolith, gateway isolation.
- [`docs/payment-lifecycle.md`](docs/payment-lifecycle.md) — the state
  machine and the single choke point (`applyGatewayOutcome`) every
  state-changing gateway fact flows through.
- [`docs/failure-modes.md`](docs/failure-modes.md) — every failure scenario
  from the spec, what PaySphere does about it, and where it's tested.
- [`docs/api.md`](docs/api.md) — full API reference.

## Security notes

- No card numbers, CVV, UPI PINs, or other payment credentials are ever
  stored — only gateway-issued references (order/payment IDs).
- Webhook signatures are verified over the raw request body before any
  database write.
- In production, run the API behind TLS termination and set `NODE_ENV=production`
  (the app then rejects plaintext HTTP — see `middleware/securityHeaders.js`);
  use a least-privilege database role for the app's connection string; and
  rotate `RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` per your deployment
  policy.

See spec section 18 and `docs/failure-modes.md` for the full list.
