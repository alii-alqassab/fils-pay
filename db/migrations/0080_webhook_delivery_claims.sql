-- A short lease claims each pending webhook delivery for one dispatcher
-- replica while its HTTP request is in flight. Expired leases are eligible
-- for retry after a process crash.
ALTER TABLE webhook_deliveries
    ADD COLUMN claim_token UUID,
    ADD COLUMN claim_expires_at TIMESTAMPTZ;
