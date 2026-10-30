/**
 * Admin account management (master only): invitations, redemption, resets,
 * disable/enable, role changes, and the guarantee that no API can create a
 * second master. Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { sha256Hex } from "../lib/crypto.js";
import { setMailTransportForTests, type MailMessage } from "../lib/mail.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("adminAccounts.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  OTP_DEV_EXPOSE: "true",
  ADMIN_CONSOLE_URL: "http://admin.example.test",
});
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const app = buildApp(config, pool);

const PASSWORD = "correct-horse-battery";
const outbox: MailMessage[] = [];
let failMail = false;
setMailTransportForTests(async (m) => {
  if (failMail) throw new Error("smtp down");
  outbox.push(m);
});

test.after(async () => {
  setMailTransportForTests(null);
  await app.close();
  await pool.end();
});

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  assert.ok(c, `expected Set-Cookie ${name}`);
  return c.value;
}

/** Real sign-in: password, then the OTP (returned because OTP_DEV_EXPOSE). */
async function signIn(email: string, password = PASSWORD): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const pending = cookieOf(login, config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [config.adminCookieName]: pending },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookieOf(verify, config.adminCookieName);
}

async function createAdmin(role: string, password = PASSWORD): Promise<{ id: string; email: string }> {
  const email = `${role}-${randomUUID()}@acc.test`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, await hashPassword(password, config), `Test ${role}`, role],
  );
  return { id: r.rows[0]!.id, email };
}

/** The single master: reuse the existing one (resetting its password in this test DB) or create it. */
async function ensureMaster(): Promise<{ id: string; email: string }> {
  const hash = await hashPassword(PASSWORD, config);
  const existing = await pool.query<{ id: string; email: string }>(
    `UPDATE admin_users SET password_hash = $1, status = 'active' WHERE role = 'master' RETURNING id, email`,
    [hash],
  );
  if (existing.rows[0]) return existing.rows[0];
  const email = `master-${randomUUID()}@acc.test`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Master', 'master') RETURNING id`,
    [email, hash],
  );
  return { id: r.rows[0]!.id, email };
}

function tokenFrom(mail: MailMessage | undefined): string {
  assert.ok(mail, "expected an email");
  const m = /accept-invite\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  assert.ok(m, "expected an invitation link in the email");
  assert.ok(mail.text.includes("http://admin.example.test/accept-invite?token="));
  return m[1]!;
}

function lastMailTo(email: string): MailMessage | undefined {
  return [...outbox].reverse().find((m) => m.to === email);
}

function as(cookie: string) {
  return { [config.adminCookieName]: cookie };
}

async function invite(cookie: string, email: string, role = "support", displayName = "Invitee") {
  return app.inject({
    method: "POST",
    url: "/v1/admin/admins/invites",
    cookies: as(cookie),
    payload: { email, displayName, role },
  });
}

async function accept(token: string, password = "a-brand-new-password", extra: object = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/auth/accept-invite",
    payload: { token, password, ...extra },
  });
}

test("every admin-account route is master-only (support, finance, super_admin get 403; anonymous 401)", async () => {
  const someId = randomUUID();
  const routes: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: object }> = [
    { method: "GET", url: "/v1/admin/admins" },
    { method: "POST", url: "/v1/admin/admins/invites", payload: { email: "x@y.test", displayName: "X", role: "support" } },
    { method: "POST", url: `/v1/admin/admins/invites/${someId}/resend` },
    { method: "DELETE", url: `/v1/admin/admins/invites/${someId}` },
    { method: "PATCH", url: `/v1/admin/admins/${someId}`, payload: { status: "disabled" } },
    { method: "POST", url: `/v1/admin/admins/${someId}/reset` },
  ];
  for (const role of ["support", "finance", "super_admin"]) {
    const a = await createAdmin(role);
    const cookie = await signIn(a.email);
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: r.url, cookies: as(cookie), payload: r.payload });
      assert.equal(res.statusCode, 403, `${role} ${r.method} ${r.url}: ${res.body}`);
    }
  }
  for (const r of routes) {
    const res = await app.inject({ method: r.method, url: r.url, payload: r.payload });
    assert.equal(res.statusCode, 401, `anon ${r.method} ${r.url}`);
  }
});

test("/me reports the master role; list never exposes hashes or tokens", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const me = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(cookie) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, "master");

  const email = `list-${randomUUID()}@acc.test`;
  assert.equal((await invite(cookie, email)).statusCode, 201);
  const list = await app.inject({ method: "GET", url: "/v1/admin/admins", cookies: as(cookie) });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.ok(body.admins.some((a: { role: string }) => a.role === "master"));
  const inv = body.invites.find((i: { email: string }) => i.email === email);
  assert.ok(inv);
  assert.equal(inv.status, "open");
  assert.equal(inv.purpose, "invite");
  assert.doesNotMatch(list.body, /password|token_hash|tokenHash|\$argon2/i);
});

test("invite -> email -> redeem -> sign in; token stored hashed; audit rows written; token not reusable", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const email = `Newbie-${randomUUID()}@Acc.Test`;
  const res = await invite(cookie, email, "finance", "New Bie");
  assert.equal(res.statusCode, 201, res.body);
  const created = res.json().invite;
  assert.equal(created.email, email.toLowerCase());
  assert.equal(created.role, "finance");
  assert.equal(created.status, "open");

  const mail = lastMailTo(email.toLowerCase());
  const token = tokenFrom(mail);
  assert.ok(!res.body.includes(token), "response must not contain the token");

  // Hash only in the database.
  const row = await pool.query<{ token_hash: string; expires_at: Date; created_at: Date }>(
    `SELECT token_hash, expires_at, created_at FROM admin_account_invites WHERE id = $1`,
    [created.id],
  );
  assert.equal(row.rows[0]!.token_hash, sha256Hex(token));
  const dump = await pool.query(`SELECT count(*)::int AS n FROM admin_account_invites WHERE row_to_json(admin_account_invites)::text LIKE $1`, [`%${token}%`]);
  assert.equal(dump.rows[0].n, 0);
  const hours = (row.rows[0]!.expires_at.getTime() - row.rows[0]!.created_at.getTime()) / 3_600_000;
  assert.ok(hours > 47.9 && hours < 48.1, `expiry ${hours}h`);

  // Cannot sign in before redeeming.
  const early = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: email.toLowerCase(), password: "a-brand-new-password" } });
  assert.equal(early.statusCode, 401);

  // Short password rejected, invite stays usable.
  assert.equal((await accept(token, "short")).statusCode, 400);

  const ok = await accept(token);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.cookies.length, 0, "accept-invite must not log the user in");

  const user = await pool.query<{ id: string; role: string; status: string; password_hash: string }>(
    `SELECT id, role, status, password_hash FROM admin_users WHERE email = $1`,
    [email.toLowerCase()],
  );
  assert.equal(user.rows[0]!.role, "finance");
  assert.equal(user.rows[0]!.status, "active");
  assert.notEqual(user.rows[0]!.password_hash, "a-brand-new-password");

  // Reuse is refused generically.
  const again = await accept(token);
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error, "invalid_invite");

  // They can now sign in normally (password + OTP) and see their role.
  const session = await signIn(email.toLowerCase(), "a-brand-new-password");
  const me = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(session) });
  assert.equal(me.json().role, "finance");

  const audit = await pool.query<{ action: string; admin_user_id: string; outcome: string }>(
    `SELECT action, admin_user_id, outcome FROM admin_audit_log
      WHERE (action = 'admin_invite_created' AND target_id = $1)
         OR (action = 'admin_invite_redeemed' AND target_id = $1)`,
    [created.id],
  );
  const byAction = new Map(audit.rows.map((r) => [r.action, r]));
  assert.equal(byAction.get("admin_invite_created")?.admin_user_id, master.id);
  assert.equal(byAction.get("admin_invite_redeemed")?.admin_user_id, user.rows[0]!.id);
});

test("accept-invite is public and answers every failure with the same generic 400", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);

  // Unknown, malformed, empty, expired, revoked, already used.
  const expiredEmail = `exp-${randomUUID()}@acc.test`;
  await invite(cookie, expiredEmail);
  const expiredToken = tokenFrom(lastMailTo(expiredEmail));
  await pool.query(
    `UPDATE admin_account_invites SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
    [sha256Hex(expiredToken)],
  );

  const revokedEmail = `rev-${randomUUID()}@acc.test`;
  const revRes = await invite(cookie, revokedEmail);
  const revokedToken = tokenFrom(lastMailTo(revokedEmail));
  const del = await app.inject({
    method: "DELETE",
    url: `/v1/admin/admins/invites/${revRes.json().invite.id}`,
    cookies: as(cookie),
  });
  assert.equal(del.statusCode, 204);

  const usedEmail = `used-${randomUUID()}@acc.test`;
  await invite(cookie, usedEmail);
  const usedToken = tokenFrom(lastMailTo(usedEmail));
  assert.equal((await accept(usedToken)).statusCode, 200);

  const bodies = new Set<string>();
  for (const token of ["nope", "", "x".repeat(500), randomUUID(), expiredToken, revokedToken, usedToken]) {
    const res = await accept(token);
    assert.equal(res.statusCode, 400, `token ${token.slice(0, 10)}`);
    bodies.add(res.body);
  }
  assert.equal(bodies.size, 1, "all failures must be byte-identical");
  assert.equal(JSON.parse([...bodies][0]!).error, "invalid_invite");

  // No admin rows for the expired/revoked invites.
  const n = await pool.query(`SELECT 1 FROM admin_users WHERE email = ANY($1)`, [[expiredEmail, revokedEmail]]);
  assert.equal(n.rows.length, 0);
});

test("cannot invite an existing admin (409), master role rejected, bad input rejected, re-invite revokes the old link", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const existing = await createAdmin("support");

  const dup = await invite(cookie, existing.email.toUpperCase());
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error, "admin_exists");

  const asMaster = await invite(cookie, `m-${randomUUID()}@acc.test`, "master");
  assert.equal(asMaster.statusCode, 400);
  assert.equal((await invite(cookie, `m-${randomUUID()}@acc.test`, "owner")).statusCode, 400);
  assert.equal((await invite(cookie, "not-an-email")).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/admin/admins/invites", cookies: as(cookie), payload: { email: `a-${randomUUID()}@acc.test`, role: "support" } })).statusCode,
    400,
  );

  const email = `again-${randomUUID()}@acc.test`;
  await invite(cookie, email);
  const first = tokenFrom(lastMailTo(email));
  const second = await invite(cookie, email, "finance");
  assert.equal(second.statusCode, 201);
  const secondToken = tokenFrom(lastMailTo(email));
  assert.notEqual(first, secondToken);
  assert.equal((await accept(first)).statusCode, 400);
  assert.equal((await accept(secondToken)).statusCode, 200);

  // Acceptance after the email appeared meanwhile -> 409 admin_exists.
  const race = `race-${randomUUID()}@acc.test`;
  await invite(cookie, race);
  const raceToken = tokenFrom(lastMailTo(race));
  await createAdmin("support").then((a) => pool.query(`UPDATE admin_users SET email = $2 WHERE id = $1`, [a.id, race]));
  const raced = await accept(raceToken);
  assert.equal(raced.statusCode, 409);
  assert.equal(raced.json().error, "admin_exists");
});

test("resend issues a new token and kills the old; revoke kills the link; 404 for unknown/redeemed ids", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const email = `resend-${randomUUID()}@acc.test`;
  const created = (await invite(cookie, email)).json().invite;
  const t1 = tokenFrom(lastMailTo(email));

  const re = await app.inject({ method: "POST", url: `/v1/admin/admins/invites/${created.id}/resend`, cookies: as(cookie) });
  assert.equal(re.statusCode, 200, re.body);
  const t2 = tokenFrom(lastMailTo(email));
  assert.notEqual(t1, t2);
  assert.ok(!re.body.includes(t2));
  assert.equal((await accept(t1)).statusCode, 400);

  // The old invite id is now revoked: resend/revoke on it -> 404.
  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/admin/admins/invites/${created.id}/resend`, cookies: as(cookie) })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: `/v1/admin/admins/invites/${randomUUID()}`, cookies: as(cookie) })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: `/v1/admin/admins/invites/not-a-uuid`, cookies: as(cookie) })).statusCode,
    404,
  );
  assert.equal((await accept(t2)).statusCode, 200);

  const audit = await pool.query(`SELECT action FROM admin_audit_log WHERE action IN ('admin_invite_resent') AND metadata->>'email' = $1`, [email]);
  assert.equal(audit.rows.length, 1);
});

test("email failure -> 503 email_delivery_unavailable, no open invite left, old invite survives", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const email = `fail-${randomUUID()}@acc.test`;

  failMail = true;
  try {
    const res = await invite(cookie, email);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error, "email_delivery_unavailable");
    const open = await pool.query(`SELECT 1 FROM admin_account_invites WHERE lower(email) = $1`, [email]);
    assert.equal(open.rows.length, 0);
  } finally {
    failMail = false;
  }

  // A failed re-send must leave the previous invitation usable.
  const created = (await invite(cookie, email)).json().invite;
  const token = tokenFrom(lastMailTo(email));
  failMail = true;
  try {
    const res = await app.inject({ method: "POST", url: `/v1/admin/admins/invites/${created.id}/resend`, cookies: as(cookie) });
    assert.equal(res.statusCode, 503);
  } finally {
    failMail = false;
  }
  const open = await pool.query(`SELECT id FROM admin_account_invites WHERE lower(email) = $1 AND revoked_at IS NULL AND redeemed_at IS NULL`, [email]);
  assert.equal(open.rows.length, 1);
  assert.equal(open.rows[0].id, created.id);
  assert.equal((await accept(token)).statusCode, 200);

  const failed = await pool.query(`SELECT 1 FROM admin_audit_log WHERE outcome = 'failed' AND action = 'admin_invite_created' AND metadata->>'email' = $1`, [email]);
  assert.equal(failed.rows.length, 1);
});

test("reset flow: new password works, old one does not, ALL sessions revoked, role untouched, link single-use", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const target = await createAdmin("finance");
  const targetSession = await signIn(target.email);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(targetSession) })).statusCode, 200);

  const res = await app.inject({ method: "POST", url: `/v1/admin/admins/${target.id}/reset`, cookies: as(cookie) });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().invite.purpose, "reset");
  const token = tokenFrom(lastMailTo(target.email));
  assert.ok(!res.body.includes(token));

  // Sending the reset alone does not touch the old session or password.
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(targetSession) })).statusCode, 200);

  assert.equal((await accept(token, "my-new-long-password")).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(targetSession) })).statusCode, 401);
  const oldLogin = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: target.email, password: PASSWORD } });
  assert.equal(oldLogin.statusCode, 401);
  const fresh = await signIn(target.email, "my-new-long-password");
  const me = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(fresh) });
  assert.equal(me.json().role, "finance");
  assert.equal((await accept(token, "yet-another-long-password")).statusCode, 400);

  // Reset ignores the invite's role column (the master's own setup link uses a placeholder).
  await pool.query(`UPDATE admin_users SET role = 'support' WHERE id = $1`, [target.id]);
  await app.inject({ method: "POST", url: `/v1/admin/admins/${target.id}/reset`, cookies: as(cookie) });
  await pool.query(`UPDATE admin_account_invites SET role = 'super_admin' WHERE admin_user_id = $1 AND revoked_at IS NULL AND redeemed_at IS NULL`, [target.id]);
  assert.equal((await accept(tokenFrom(lastMailTo(target.email)), "third-long-password-x")).statusCode, 200);
  const role = await pool.query(`SELECT role FROM admin_users WHERE id = $1`, [target.id]);
  assert.equal(role.rows[0].role, "support");

  const audit = await pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'admin_reset_sent' AND target_id = $1`, [target.id]);
  assert.equal(audit.rows.length, 2);

  // Email failure on reset -> 503.
  failMail = true;
  try {
    const bad = await app.inject({ method: "POST", url: `/v1/admin/admins/${target.id}/reset`, cookies: as(cookie) });
    assert.equal(bad.statusCode, 503);
  } finally {
    failMail = false;
  }
});

test("disable revokes sessions at once and blocks login; enable restores; role change works and is audited", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const target = await createAdmin("support");
  const targetSession = await signIn(target.email);
  await pool.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ('Imp', 250)`);
  const merchant = await pool.query<{ id: string }>(`SELECT id FROM merchants ORDER BY created_at DESC LIMIT 1`);
  const grant = await pool.query<{ id: string }>(
    `INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [target.id, merchant.rows[0]!.id, sha256Hex(randomUUID())],
  );

  const dis = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${target.id}`, cookies: as(cookie), payload: { status: "disabled" } });
  assert.equal(dis.statusCode, 200, dis.body);
  assert.equal(dis.json().admin.status, "disabled");
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(targetSession) })).statusCode, 401);
  const sessions = await pool.query(`SELECT 1 FROM admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL`, [target.id]);
  assert.equal(sessions.rows.length, 0);
  const g = await pool.query(`SELECT revoked_at FROM admin_impersonation_grants WHERE id = $1`, [grant.rows[0]!.id]);
  assert.ok(g.rows[0].revoked_at);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: target.email, password: PASSWORD } });
  assert.equal(login.statusCode, 401);

  const en = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${target.id}`, cookies: as(cookie), payload: { status: "active", role: "super_admin" } });
  assert.equal(en.statusCode, 200);
  assert.equal(en.json().admin.role, "super_admin");
  const back = await signIn(target.email);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(back) })).json().role, "super_admin");

  const audit = await pool.query<{ metadata: { before: { role: string; status: string }; after: { role: string; status: string } } }>(
    `SELECT metadata FROM admin_audit_log WHERE action = 'admin_updated' AND target_id = $1 ORDER BY created_at`,
    [target.id],
  );
  assert.equal(audit.rows.length, 2);
  assert.equal(audit.rows[0]!.metadata.after.status, "disabled");
  assert.equal(audit.rows[1]!.metadata.after.role, "super_admin");

  // Validation
  for (const payload of [{}, { status: "banned" }, { role: "owner" }]) {
    const bad = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${target.id}`, cookies: as(cookie), payload });
    assert.equal(bad.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/admin/admins/${randomUUID()}`, cookies: as(cookie), payload: { status: "disabled" } })).statusCode, 404);
});

test("nobody can create, promote, demote, disable or reset the master through the API", async () => {
  const master = await ensureMaster();
  const cookie = await signIn(master.email);
  const target = await createAdmin("super_admin");

  // Invite with role master.
  const inv = await invite(cookie, `boss-${randomUUID()}@acc.test`, "master");
  assert.equal(inv.statusCode, 400);

  // Promote to master via PATCH.
  const promote = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${target.id}`, cookies: as(cookie), payload: { role: "master" } });
  assert.equal(promote.statusCode, 400);

  // Even the database refuses a second master.
  await assert.rejects(pool.query(`UPDATE admin_users SET role = 'master' WHERE id = $1`, [target.id]));

  // Touching the master itself.
  for (const payload of [{ role: "support" }, { status: "disabled" }]) {
    const res = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${master.id}`, cookies: as(cookie), payload });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "cannot_modify_master");
  }
  const reset = await app.inject({ method: "POST", url: `/v1/admin/admins/${master.id}/reset`, cookies: as(cookie) });
  assert.equal(reset.statusCode, 403);

  const masters = await pool.query(`SELECT 1 FROM admin_users WHERE role = 'master'`);
  assert.equal(masters.rows.length, 1);
  const stillMaster = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: as(cookie) });
  assert.equal(stillMaster.json().role, "master");
});

test("a super_admin elevated by the master still cannot manage admins", async () => {
  const sa = await createAdmin("super_admin");
  const cookie = await signIn(sa.email);
  const res = await invite(cookie, `x-${randomUUID()}@acc.test`, "support");
  assert.equal(res.statusCode, 403);
  const self = await app.inject({ method: "PATCH", url: `/v1/admin/admins/${sa.id}`, cookies: as(cookie), payload: { role: "master" } });
  assert.equal(self.statusCode, 403);
});
