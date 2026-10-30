-- Ledger corrections are made by posting new balanced entry groups. Existing
-- entries must never be edited or removed: the deferred balance trigger in
-- 0007 only protects the final group balance and cannot enforce immutability.
CREATE FUNCTION reject_ledger_entry_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only; % is not allowed', TG_OP
        USING ERRCODE = '55000';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_reject_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_mutation();

-- TRUNCATE does not fire row-level UPDATE/DELETE triggers, so guard it too.
CREATE TRIGGER ledger_entries_reject_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_entry_mutation();
