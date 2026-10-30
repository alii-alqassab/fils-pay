-- A payment-link reservation can be reclaimed after its timeout even while
-- the original request is still executing. Keep a link-scoped attempt number
-- so concurrent/stale requests use the same downstream idempotency keys.
-- Increment it only after an authorization attempt fails, allowing a later
-- customer retry to use a fresh authorization/capture identity.
ALTER TABLE payment_links
    ADD COLUMN payment_attempt INTEGER NOT NULL DEFAULT 0
        CHECK (payment_attempt >= 0),
    ADD COLUMN payment_attempt_key TEXT,
    ADD COLUMN reservation_token UUID;
