-- Prevent callbacks from persisting outcome values outside the fraud review
-- verdicts understood by the API. NOT VALID avoids blocking deployment if
-- older rows contain invalid values; PostgreSQL enforces the check on every
-- new or updated row immediately.
ALTER TABLE acquirer_callback_notes
    ADD CONSTRAINT acquirer_callback_notes_outcome_check
    CHECK (outcome IN ('cleared', 'confirmed_fraud')) NOT VALID;
