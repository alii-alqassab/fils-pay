-- Claim each acquirer callback ID exactly once. Keeping receipts separate
-- from the append-only notes table lets existing duplicate notes remain
-- intact while preventing future redeliveries from adding more.
CREATE TABLE acquirer_callback_receipts (
    callback_id  TEXT PRIMARY KEY,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing callback IDs have already been accepted. Seed the receipts table
-- from them so a redelivery after deployment does not create another note.
INSERT INTO acquirer_callback_receipts (callback_id)
SELECT DISTINCT callback_id
  FROM acquirer_callback_notes
ON CONFLICT (callback_id) DO NOTHING;
