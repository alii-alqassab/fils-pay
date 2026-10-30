-- Company IDs and staff approval.
--
-- 1. merchants.company_code: a human-friendly unique ID (e.g. FP-7K3M-9QXA)
--    assigned by the database the moment a company becomes 'approved', so every
--    approval path (single review, bulk approve, scripts, seed) gets one.
--    Staff use it to ask to join the company. It never changes once set.
-- 2. merchant_users.status: staff join requests wait as
--    'pending_owner_approval' until the company owner approves them.
--    Default 'active' keeps every existing user working.

ALTER TABLE merchants ADD COLUMN company_code text;
CREATE UNIQUE INDEX uq_merchants_company_code ON merchants (company_code) WHERE company_code IS NOT NULL;

CREATE FUNCTION fp_new_company_code() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 symbols, no 0/O/1/I
  -- uuid v4 bytes 6 and 8 carry fixed version/variant bits, so they are skipped
  pick constant int[] := ARRAY[0, 1, 2, 3, 4, 5, 9, 10];
  raw bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  result text := 'FP-';
  i int;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, (get_byte(raw, pick[i]) % 32) + 1, 1);
    IF i = 4 THEN
      result := result || '-';
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION fp_assign_company_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
  attempts int := 0;
BEGIN
  LOOP
    candidate := fp_new_company_code();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM merchants WHERE company_code = candidate);
    attempts := attempts + 1;
    IF attempts > 20 THEN
      RAISE EXCEPTION 'could not generate a unique company code';
    END IF;
  END LOOP;
  NEW.company_code := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_merchants_assign_company_code
  BEFORE INSERT OR UPDATE OF onboarding_status ON merchants
  FOR EACH ROW
  WHEN (NEW.onboarding_status = 'approved' AND NEW.company_code IS NULL)
  EXECUTE FUNCTION fp_assign_company_code();

CREATE FUNCTION fp_company_code_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.company_code IS NOT NULL AND NEW.company_code IS DISTINCT FROM OLD.company_code THEN
    RAISE EXCEPTION 'merchants.company_code cannot be changed once assigned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_merchants_company_code_immutable
  BEFORE UPDATE OF company_code ON merchants
  FOR EACH ROW
  EXECUTE FUNCTION fp_company_code_immutable();

-- Give already-approved companies a code (fires the assign trigger).
UPDATE merchants SET onboarding_status = onboarding_status
 WHERE onboarding_status = 'approved' AND company_code IS NULL;

ALTER TABLE merchant_users
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_owner_approval', 'rejected', 'disabled')),
  ADD COLUMN full_name text,
  ADD COLUMN requested_role text CHECK (requested_role IN ('finance', 'support')),
  ADD COLUMN approved_by_user_id uuid REFERENCES merchant_users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN status_changed_at timestamptz;

CREATE INDEX merchant_users_pending_idx ON merchant_users (merchant_id) WHERE status = 'pending_owner_approval';
