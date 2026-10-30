/**
 * The single master admin: created and recovered only by the server-side
 * command. Requires DATABASE_URL (migrated). Each test starts from "no master".
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { verifyPassword } from "../auth/passwords.js";
import { setMailTransportForTests, type MailMessage } from "../lib/mail.js";
import { sha256Hex } from "../lib/crypto.js";
import { createMaster, resetMaster } from "./masterAccount.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("masterAccount.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ADMIN_CONSOLE_URL: "http://console.test",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });

/** Gets back to "no master exists". Other test files may have used the master (sessions, OTP
 *  challenges, audit rows point at it), so instead of deleting it we retire it: it becomes a
 *  disabled super_admin under a throwaway email. */
async function wipeMaster(): Promise<void> {
  await pool.query(
    `UPDATE admin_users
        SET role = 'super_admin', status = 'disabled', email = 'retired-' || id::text || '@retired.test'
      WHERE role = 'master'`,
  );
}
beforeEach(wipeMaster);
afterEach(() => setMailTransportForTests(null));
test.after(async () => {
  await wipeMaster();
  await pool.end();
});

test("creates the master with a hashed password and an audit row", async () => {
  const r = await createMaster(pool, config, { email: "Boss@Example.test", displayName: "The Boss", password: "correct-horse-battery" });
  assert.equal(r.email, "boss@example.test");
  const row = await pool.query(`SELECT role, status, password_hash, display_name FROM admin_users WHERE id = $1`, [r.adminUserId]);
  assert.equal(row.rows[0].role, "master");
  assert.equal(row.rows[0].status, "active");
  assert.notEqual(row.rows[0].password_hash, "correct-horse-battery");
  assert.equal(await verifyPassword(row.rows[0].password_hash, "correct-horse-battery"), true);
  const audit = await pool.query(`SELECT action FROM admin_audit_log WHERE admin_user_id = $1`, [r.adminUserId]);
  assert.deepEqual(audit.rows.map((a) => a.action), ["master_created"]);
});

test("there can only be one master", async () => {
  await createMaster(pool, config, { email: "boss@example.test", password: "correct-horse-battery" });
  await assert.rejects(
    () => createMaster(pool, config, { email: "second@example.test", password: "another-long-password" }),
    /already exists/,
  );
  const n = await pool.query(`SELECT count(*)::int AS n FROM admin_users WHERE role = 'master'`);
  assert.equal(n.rows[0].n, 1);
});

test("the database itself refuses a second master even if the code is bypassed", async () => {
  await createMaster(pool, config, { email: "boss@example.test", password: "correct-horse-battery" });
  await assert.rejects(
    () => pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ('x@example.test','h','X','master')`),
    /uq_admin_users_single_master/,
  );
});

test("rejects a short password, a bad email, and no password at all", async () => {
  await assert.rejects(() => createMaster(pool, config, { email: "boss@example.test", password: "short" }), /at least 12/);
  await assert.rejects(() => createMaster(pool, config, { email: "not-an-email", password: "correct-horse-battery" }), /valid --email/);
  await assert.rejects(() => createMaster(pool, config, { email: "boss@example.test" }), /password/i);
});

test("--setup-email: random unusable password, one-time hashed link by email, no password stored in the link", async () => {
  const sent: MailMessage[] = [];
  setMailTransportForTests(async (m) => void sent.push(m));
  const r = await createMaster(pool, config, { email: "boss@example.test", sendSetupEmail: true });
  assert.equal(r.setupEmailSent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "boss@example.test");
  const link = /(http:\/\/console\.test\/accept-invite\?token=([A-Za-z0-9_-]+))/.exec(sent[0]!.text);
  assert.ok(link, "email must contain the setup link");
  const token = link[2]!;
  const invite = await pool.query(`SELECT token_hash, purpose, admin_user_id, expires_at FROM admin_account_invites WHERE admin_user_id = $1`, [r.adminUserId]);
  assert.equal(invite.rows.length, 1);
  assert.equal(invite.rows[0].purpose, "reset");
  assert.equal(invite.rows[0].token_hash, sha256Hex(token));
  assert.ok(!JSON.stringify(invite.rows[0]).includes(token), "the raw token must not be stored");
  assert.ok(invite.rows[0].expires_at.getTime() > Date.now() + 47 * 3_600_000);
});

test("--setup-email: if the email cannot be sent the account stays but no dangling link is left", async () => {
  setMailTransportForTests(async () => {
    throw new Error("smtp down");
  });
  const r = await createMaster(pool, config, { email: "boss@example.test", sendSetupEmail: true });
  assert.equal(r.setupEmailSent, false);
  const open = await pool.query(`SELECT count(*)::int AS n FROM admin_account_invites WHERE admin_user_id = $1`, [r.adminUserId]);
  assert.equal(open.rows[0].n, 0);
});

test("reset: new password works, old sessions are revoked, audit row written", async () => {
  const r = await createMaster(pool, config, { email: "boss@example.test", password: "correct-horse-battery" });
  await pool.query(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, authenticated, expires_at) VALUES ($1, $2, true, now() + interval '1 hour')`,
    [r.adminUserId, randomUUID()],
  );
  await resetMaster(pool, config, { password: "a-brand-new-long-password" });
  const row = await pool.query(`SELECT password_hash FROM admin_users WHERE id = $1`, [r.adminUserId]);
  assert.equal(await verifyPassword(row.rows[0].password_hash, "a-brand-new-long-password"), true);
  assert.equal(await verifyPassword(row.rows[0].password_hash, "correct-horse-battery"), false);
  const live = await pool.query(`SELECT count(*)::int AS n FROM admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL`, [r.adminUserId]);
  assert.equal(live.rows[0].n, 0);
  const audit = await pool.query(`SELECT action FROM admin_audit_log WHERE admin_user_id = $1 ORDER BY created_at`, [r.adminUserId]);
  assert.ok(audit.rows.some((a) => a.action === "master_password_reset"));
});

test("reset with no master, or with someone else's email, is refused", async () => {
  await assert.rejects(() => resetMaster(pool, config, { password: "a-brand-new-long-password" }), /no master/);
  await createMaster(pool, config, { email: "boss@example.test", password: "correct-horse-battery" });
  await assert.rejects(() => resetMaster(pool, config, { email: "other@example.test", password: "a-brand-new-long-password" }), /not the master/);
});
