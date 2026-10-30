-- BIGSERIAL ids are allocated before their transaction commits, so the
-- reporting cursor alone can skip an event that commits later with a lower
-- id. Track each applied event in the same transaction as its rollup writes.
CREATE TABLE reporting_outbox_processed_events (
    event_id     BIGINT PRIMARY KEY REFERENCES outbox_events (id) ON DELETE CASCADE,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve the existing read model when upgrading: events at or below the
-- stored watermark have already been applied according to the old consumer.
-- A reporting rebuild can clear markers and replay the full history.
INSERT INTO reporting_outbox_processed_events (event_id)
SELECT e.id
  FROM outbox_events e
 WHERE e.id <= COALESCE(
   (SELECT c.last_processed_id
      FROM reporting_outbox_cursor c
     WHERE c.consumer_name = 'reporting'),
   0
 )
   AND e.event_type IN (
     'transaction.captured', 'transaction.voided',
     'settlement.batch_closed', 'settlement.paid'
   );
