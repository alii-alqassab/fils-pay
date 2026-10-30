-- Retain endpoint rows as disabled tombstones so webhook delivery and archive
-- history keeps its endpoint foreign key after a merchant removes an endpoint.
ALTER TABLE webhook_endpoints
    ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE INDEX idx_webhook_endpoints_not_deleted
    ON webhook_endpoints (merchant_id, created_at DESC)
    WHERE deleted_at IS NULL;
