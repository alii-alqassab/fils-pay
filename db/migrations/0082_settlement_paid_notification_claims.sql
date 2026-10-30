-- Serialize settlement.paid event creation per batch across concurrent
-- payout notification scans. Existing events are represented as claimed so
-- a rollout cannot enqueue a second event for an already-notified batch.
CREATE TABLE settlement_paid_notification_claims (
    settlement_batch_id UUID PRIMARY KEY REFERENCES settlement_batches (id),
    claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settlement_paid_notification_claims (settlement_batch_id)
SELECT DISTINCT aggregate_id
  FROM outbox_events
 WHERE event_type = 'settlement.paid'
ON CONFLICT (settlement_batch_id) DO NOTHING;
