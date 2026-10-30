-- Invitations (and password resets) for admin accounts. The master chooses an
-- email, name and role; the invited person receives a one-time link and picks
-- their own password. Only a SHA-256 hash of the 32-byte token is stored.
-- (The older admin_invites table is unused and left untouched.)
CREATE TABLE admin_account_invites (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    text        NOT NULL,
  display_name             text        NOT NULL,
  role                     text        NOT NULL CHECK (role IN ('support', 'finance', 'super_admin')),
  purpose                  text        NOT NULL DEFAULT 'invite' CHECK (purpose IN ('invite', 'reset')),
  admin_user_id            uuid        REFERENCES admin_users(id),
  token_hash               text        NOT NULL UNIQUE,
  created_by_admin_user_id uuid        NOT NULL REFERENCES admin_users(id),
  expires_at               timestamptz NOT NULL,
  redeemed_at              timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_admin_invite_reset_has_user CHECK (purpose <> 'reset' OR admin_user_id IS NOT NULL)
);

-- At most one open (not redeemed, not revoked) invitation per email.
CREATE UNIQUE INDEX uq_admin_account_invites_open_email
  ON admin_account_invites (lower(email))
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;
