-- A batch has one operational disbursement record regardless of the number of
-- webhook endpoints or retries. Earlier webhook-driven writes could create
-- multiple references for the same payout; preserve those rows and link them
-- to the earliest record rather than deleting reference history.
ALTER TABLE settlement_payout_disbursements
    ADD COLUMN duplicate_of_id UUID REFERENCES settlement_payout_disbursements (id);

WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
               PARTITION BY settlement_batch_id
               ORDER BY created_at, id
           ) AS primary_id,
           row_number() OVER (
               PARTITION BY settlement_batch_id
               ORDER BY created_at, id
           ) AS row_number
      FROM settlement_payout_disbursements
)
UPDATE settlement_payout_disbursements d
   SET duplicate_of_id = ranked.primary_id
  FROM ranked
 WHERE d.id = ranked.id
   AND ranked.row_number > 1;

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id)
    WHERE duplicate_of_id IS NULL;

-- Repair paid batches that have no canonical record. This covers payouts
-- created before the record was moved into the settlement transaction.
INSERT INTO settlement_payout_disbursements
    (settlement_batch_id, amount_fils, disbursement_reference)
SELECT sb.id, sb.net_payout_fils, 'disb_' || gen_random_uuid()
  FROM settlement_batches sb
 WHERE sb.status = 'paid'
   AND sb.net_payout_fils > 0
   AND NOT EXISTS (
       SELECT 1
         FROM settlement_payout_disbursements d
        WHERE d.settlement_batch_id = sb.id
          AND d.duplicate_of_id IS NULL
   )
ON CONFLICT (settlement_batch_id) WHERE duplicate_of_id IS NULL DO NOTHING;
