-- A transaction can never have refunded more than it captured. NOT VALID
-- enforces the rule for every new write without rescanning historical rows.
ALTER TABLE transactions
    ADD CONSTRAINT transactions_refunded_within_captured_check
    CHECK (refunded_fils <= captured_fils) NOT VALID;
