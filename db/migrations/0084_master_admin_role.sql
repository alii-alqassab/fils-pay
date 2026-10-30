-- One master account (the "big boss"): the only role allowed to create,
-- invite, disable or re-role admin accounts. The unique index guarantees at
-- most one master can ever exist; the application also refuses to create one
-- through any API (only the server-side `npm run master:create` command can).
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('support', 'finance', 'super_admin', 'master'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_single_master
  ON admin_users ((true))
  WHERE role = 'master';
