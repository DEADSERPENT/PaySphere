-- PaySphere payment-domain schema.
-- IDs are human-readable prefixed strings (pay_, pord_, patt_, txn_, whk_, idem_, hist_)
-- generated in application code, not database sequences, so that the payment
-- reference returned to callers never depends on an internal auto-increment.

CREATE TABLE IF NOT EXISTS payment_intents (
    id                  TEXT PRIMARY KEY,
    external_order_id   TEXT NOT NULL,
    amount              BIGINT NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL,
    customer_reference  TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents (status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_external_order_id ON payment_intents (external_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status_updated_at ON payment_intents (status, updated_at);

CREATE TABLE IF NOT EXISTS payment_orders (
    id                  TEXT PRIMARY KEY,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents (id),
    gateway             TEXT NOT NULL,
    gateway_order_id    TEXT NOT NULL,
    status              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gateway, gateway_order_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_payment_intent_id ON payment_orders (payment_intent_id);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id                  TEXT PRIMARY KEY,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents (id),
    attempt_number      INTEGER NOT NULL,
    gateway             TEXT NOT NULL,
    gateway_payment_id  TEXT,
    status              TEXT NOT NULL,
    failure_code        TEXT,
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (payment_intent_id, attempt_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_gateway_payment_id
    ON payment_attempts (gateway, gateway_payment_id)
    WHERE gateway_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_attempts_payment_intent_id ON payment_attempts (payment_intent_id);

-- The internal financial transaction record, created only after authoritative
-- (server-verified or webhook-confirmed) gateway confirmation. The unique index
-- on gateway_payment_id is the DB-level guarantee that the same gateway event
-- can never produce two financial transactions (invariant, spec section 7).
CREATE TABLE IF NOT EXISTS transactions (
    id                  TEXT PRIMARY KEY,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents (id),
    gateway_payment_id  TEXT NOT NULL,
    amount              BIGINT NOT NULL,
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_gateway_payment_id
    ON transactions (gateway_payment_id);

CREATE INDEX IF NOT EXISTS idx_transactions_payment_intent_id ON transactions (payment_intent_id);

-- Uniqueness over (gateway, gateway_event_id) is what makes duplicate webhook
-- delivery harmless: the second insert attempt fails and is treated as an
-- already-seen event rather than reprocessed.
CREATE TABLE IF NOT EXISTS webhook_events (
    id                  TEXT PRIMARY KEY,
    gateway             TEXT NOT NULL,
    gateway_event_id    TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'RECEIVED',
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ,
    error_message       TEXT,
    UNIQUE (gateway, gateway_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);

-- Uniqueness over (scope, idempotency_key) prevents the same client key from
-- ever creating two payment intents for the same scope, regardless of how
-- many concurrent retries race to insert it first.
CREATE TABLE IF NOT EXISTS idempotency_records (
    id                  TEXT PRIMARY KEY,
    scope               TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    request_hash        TEXT NOT NULL,
    payment_intent_id   TEXT REFERENCES payment_intents (id),
    response_status     INTEGER,
    response_payload    JSONB,
    status              TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS payment_state_history (
    id                  TEXT PRIMARY KEY,
    payment_intent_id   TEXT NOT NULL REFERENCES payment_intents (id),
    from_state          TEXT,
    to_state            TEXT NOT NULL,
    reason              TEXT,
    source              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_state_history_payment_intent_id ON payment_state_history (payment_intent_id);
