/**
 * Company IDs, staff join requests, owner approval, disable/revoke, and the
 * emails around them (docs/design/accounts-roles-and-email.md sections 3.1, 3.2).
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { setMailTransportForTests, type MailMessage } from "../lib/mail.js";
import { recordKycReview } from "../onboarding/review.js";
import { normalizeCompanyCode } from "./companyCode.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("companyStaff.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  DASHBOARD_URL: "https://dash.example.test",
});
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const app = buildApp(config, pool);

const OWNER_PW = "owner-password-123!";
const STAFF_PW = "staff-password-123!";
const ADMIN_PW = "admin-test-password-9000!";
const CODE_RE = /^FP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

let sent: MailMessage[] = [];
let failMail = false;

beforeEach(() => {
  sent = [];
  failMail = false;
  setMailTransportForTests(async (message) => {
    if (failMail) throw new Error("mail provider down");
    sent.push(message);
  });
});
afterEach(() => setMailTransportForTests(null));
after(async () => {
  await app.close();
  await pool.end();
});

let ownerHash: string | null = null;
let staffHash: string | null = null;

async function createCompany(label: string, opts: { approve?: boolean; suspended?: boolean } = {}) {
  ownerHash ??= await hashPassword(OWNER_PW, config);
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Co ${label} ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const ownerEmail = `owner-${randomUUID()}@co.test`;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash, full_name)
     VALUES ($1, $2, 'owner', $3, 'Olivia Owner') RETURNING id`,
    [merchantId, ownerEmail, ownerHash],
  );
  if (opts.approve) {
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  }
  if (opts.suspended) await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [merchantId]);
  return { merchantId, ownerUserId: owner.rows[0]!.id, ownerEmail };
}

async function codeOf(merchantId: string): Promise<string | null> {
  const r = await pool.query<{ company_code: string | null }>(`SELECT company_code FROM merchants WHERE id = $1`, [merchantId]);
  return r.rows[0]!.company_code;
}

async function approvedCompany(label: string) {
  const company = await createCompany(label, { approve: true });
  const code = (await codeOf(company.merchantId))!;
  assert.match(code, CODE_RE);
  return { ...company, code };
}

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === config.cookieName);
  assert.ok(c, "expected a session cookie");
  return c.value;
}

function login(email: string, password: string, merchantId?: string) {
  return app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email, password, ...(merchantId ? { merchantId } : {}) } });
}

/** Password then OTP; returns the authenticated session token. */
async function signIn(email: string, password: string, merchantId?: string): Promise<string> {
  const res = await login(email, password, merchantId);
  assert.equal(res.statusCode, 200, res.body);
  const pending = cookieOf(res);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: pending },
    payload: { code: res.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.cookies.find((c) => c.name === config.cookieName)?.value ?? pending;
}

function as(token: string) {
  return { [config.cookieName]: token };
}

async function join(code: string, email: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/company-join",
    payload: { companyCode: code, fullName: "Sam Staff", email, password: STAFF_PW, requestedRole: "finance", ...extra },
  });
}

async function staffRow(merchantId: string, email: string) {
  const r = await pool.query<{
    id: string; status: string; role: string; requested_role: string; full_name: string;
    approved_by_user_id: string | null; approved_at: Date | null;
  }>(
    `SELECT id, status, role, requested_role, full_name, approved_by_user_id, approved_at
       FROM merchant_users WHERE merchant_id = $1 AND email = $2`,
    [merchantId, email],
  );
  return r.rows[0]!;
}

let adminCookie: string | null = null;
async function financeAdminCookie(): Promise<string> {
  if (adminCookie) return adminCookie;
  const email = `fin-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Fin', 'finance')`, [
    email,
    await hashPassword(ADMIN_PW, config),
  ]);
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: ADMIN_PW } });
  assert.equal(res.statusCode, 200, res.body);
  const pending = res.cookies.find((c) => c.name === config.adminCookieName)!.value;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [config.adminCookieName]: pending },
    payload: { code: res.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  adminCookie = verify.cookies.find((c) => c.name === config.adminCookieName)?.value ?? pending;
  return adminCookie;
}

async function adminReview(merchantId: string, outcome: "approved" | "rejected", notes?: string) {
  return app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    cookies: { [config.adminCookieName]: await financeAdminCookie() },
    payload: { outcome, notes },
  });
}

/** Creates an active staff member directly (approved earlier). */
async function activeStaff(merchantId: string, ownerUserId: string, role: "finance" | "support", label: string) {
  staffHash ??= await hashPassword(STAFF_PW, config);
  const email = `${label}-${randomUUID()}@staff.test`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash, full_name, status, approved_by_user_id, approved_at)
     VALUES ($1, $2, $3, $4, 'Staff', 'active', $5, now()) RETURNING id`,
    [merchantId, email, role, staffHash, ownerUserId],
  );
  return { id: r.rows[0]!.id, email };
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ------------------------------------------------------------ company code

test("normalizeCompanyCode accepts any casing/dash style and rejects junk", () => {
  assert.equal(normalizeCompanyCode("fp-7k3m-9qxa"), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("  FP7K3M9QXA "), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("7K3M-9QXA"), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("FP-7K3M-9QX0"), null); // 0 is not in the alphabet
  assert.equal(normalizeCompanyCode("FP-7K3M"), null);
  assert.equal(normalizeCompanyCode(42), null);
});

test("company_code is empty before approval and assigned by the admin review route", async () => {
  const company = await createCompany("review");
  assert.equal(await codeOf(company.merchantId), null);

  const res = await adminReview(company.merchantId, "approved", "all good");
  assert.equal(res.statusCode, 200, res.body);
  const code = await codeOf(company.merchantId);
  assert.match(code!, CODE_RE);

  const mail = sent.find((m) => m.to === company.ownerEmail);
  assert.ok(mail, "owner gets the approval email");
  assert.ok(mail.text.includes(code!), "email carries the company ID");
  assert.ok(mail.text.includes("https://dash.example.test/dashboard/join"));
});

test("a rejected company gets no code and the owner gets the rejection note", async () => {
  const company = await createCompany("rejected");
  const res = await adminReview(company.merchantId, "rejected", "Registration number unreadable");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await codeOf(company.merchantId), null);
  const mail = sent.find((m) => m.to === company.ownerEmail);
  assert.ok(mail);
  assert.ok(mail.text.includes("Registration number unreadable"));
  assert.ok(!/FP-[A-Z0-9]{4}-/.test(mail.text));
});

test("bulk approve assigns codes and emails each owner (in the background)", async () => {
  const a = await createCompany("bulk-a");
  const b = await createCompany("bulk-b");
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = ANY($1::uuid[])`, [[a.merchantId, b.merchantId]]);
  assert.equal(await codeOf(a.merchantId), null);

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    cookies: { [config.adminCookieName]: await financeAdminCookie() },
    payload: { merchantIds: [a.merchantId, b.merchantId] },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().approvedCount, 2);
  const [ca, cb] = [await codeOf(a.merchantId), await codeOf(b.merchantId)];
  assert.match(ca!, CODE_RE);
  assert.match(cb!, CODE_RE);
  assert.notEqual(ca, cb);

  await waitFor(() => sent.length >= 2);
  assert.ok(sent.find((m) => m.to === a.ownerEmail)?.text.includes(ca!));
  assert.ok(sent.find((m) => m.to === b.ownerEmail)?.text.includes(cb!));
});

test("an email failure never fails or rolls back a review", async () => {
  const company = await createCompany("review-mailfail");
  failMail = true;
  const res = await adminReview(company.merchantId, "approved");
  assert.equal(res.statusCode, 200, res.body);
  assert.match((await codeOf(company.merchantId))!, CODE_RE);
  assert.equal(sent.length, 0);
});

test("the company code can never be changed once assigned", async () => {
  const company = await approvedCompany("immutable");
  await assert.rejects(pool.query(`UPDATE merchants SET company_code = 'FP-AAAA-BBBB' WHERE id = $1`, [company.merchantId]));
});

// ------------------------------------------------------------ join

test("join: happy path creates a pending staff user, emails the owner, returns no ids", async () => {
  const company = await approvedCompany("join");
  const email = `Sam-${randomUUID()}@staff.test`;
  // lower case and without the dash must work too
  const res = await join(company.code.toLowerCase().replace(/-/g, ""), email, { requestedRole: "finance" });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json(), { status: "pending_owner_approval" });

  const row = await staffRow(company.merchantId, email.toLowerCase());
  assert.equal(row.status, "pending_owner_approval");
  assert.equal(row.role, "finance");
  assert.equal(row.requested_role, "finance");
  assert.equal(row.full_name, "Sam Staff");
  assert.equal(row.approved_at, null);

  const pw = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM merchant_users WHERE id = $1`, [row.id]);
  assert.ok(pw.rows[0]!.password_hash.startsWith("$argon2id$"));

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, company.ownerEmail);
  assert.ok(sent[0]!.text.includes("Sam Staff"));
  assert.ok(sent[0]!.text.includes("https://dash.example.test/dashboard/team"));
});

test("join: role defaults to support; owner and junk roles are refused; weak password refused", async () => {
  const company = await approvedCompany("join-roles");
  const e1 = `a-${randomUUID()}@staff.test`;
  const def = await app.inject({
    method: "POST", url: "/v1/company-join",
    payload: { companyCode: company.code, fullName: "No Role", email: e1, password: STAFF_PW },
  });
  assert.equal(def.statusCode, 201, def.body);
  assert.equal((await staffRow(company.merchantId, e1)).role, "support");

  const owner = await join(company.code, `b-${randomUUID()}@staff.test`, { requestedRole: "owner" });
  assert.equal(owner.statusCode, 400);
  const junk = await join(company.code, `c-${randomUUID()}@staff.test`, { requestedRole: "admin" });
  assert.equal(junk.statusCode, 400);
  const weak = await join(company.code, `d-${randomUUID()}@staff.test`, { password: "short" });
  assert.equal(weak.statusCode, 400);
  const missing = await join(company.code, "not-an-email");
  assert.equal(missing.statusCode, 400);
  const rows = await pool.query(`SELECT 1 FROM merchant_users WHERE merchant_id = $1 AND role = 'owner'`, [company.merchantId]);
  assert.equal(rows.rows.length, 1, "still exactly one owner");
});

test("join: unknown, unapproved and suspended companies all give the same 404", async () => {
  const unapproved = await createCompany("unapproved");
  // a code on a company that is not approved must still not be joinable
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const body = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const unapprovedCode = `FP-${body.slice(0, 4)}-${body.slice(4)}`;
  await pool.query(`UPDATE merchants SET company_code = $2 WHERE id = $1`, [unapproved.merchantId, unapprovedCode]);
  const suspended = await approvedCompany("suspended");
  await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [suspended.merchantId]);

  const bodies = [];
  for (const code of ["FP-QQQQ-7777", unapprovedCode, suspended.code, "garbage"]) {
    const res = await join(code, `x-${randomUUID()}@staff.test`);
    assert.equal(res.statusCode, 404, `${code}: ${res.body}`);
    bodies.push(res.body);
  }
  assert.equal(new Set(bodies).size, 1, "identical response for every reason");
  assert.equal(JSON.parse(bodies[0]!).error, "company_not_found");
  assert.equal(sent.length, 0);
});

test("join: the same email twice in a company is a 409 already_requested", async () => {
  const company = await approvedCompany("dup");
  const other = await approvedCompany("dup-other");
  const email = `dup-${randomUUID()}@staff.test`;
  assert.equal((await join(company.code, email)).statusCode, 201);
  const again = await join(company.code, email.toUpperCase());
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "already_requested");
  // the same person may ask a different company
  assert.equal((await join(other.code, email)).statusCode, 201);
  // and the owner's own email is taken too
  assert.equal((await join(company.code, company.ownerEmail)).statusCode, 409);
});

test("join: at most 20 pending requests per company (429 too_many_pending)", async () => {
  const company = await approvedCompany("cap");
  staffHash ??= await hashPassword(STAFF_PW, config);
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO merchant_users (merchant_id, email, role, password_hash, status, requested_role, full_name)
       VALUES ($1, $2, 'support', $3, 'pending_owner_approval', 'support', 'P')`,
      [company.merchantId, `p${i}-${randomUUID()}@staff.test`, staffHash],
    );
  }
  const res = await join(company.code, `late-${randomUUID()}@staff.test`);
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(res.json().error, "too_many_pending");
});

test("join: an owner email that fails to send does not fail the request", async () => {
  const company = await approvedCompany("join-mailfail");
  failMail = true;
  const email = `mf-${randomUUID()}@staff.test`;
  const res = await join(company.code, email);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await staffRow(company.merchantId, email)).status, "pending_owner_approval");
});

// ------------------------------------------------------------ sign-in gating

test("a pending user cannot sign in, even with the right password, and gets no session", async () => {
  const company = await approvedCompany("pending-login");
  const email = `pend-${randomUUID()}@staff.test`;
  assert.equal((await join(company.code, email)).statusCode, 201);

  const ok = await login(email, STAFF_PW);
  assert.equal(ok.statusCode, 403);
  assert.equal(ok.json().error, "account_pending_owner_approval");
  assert.equal(ok.cookies.length, 0, "no cookie");
  const sessions = await pool.query(
    `SELECT 1 FROM sessions s JOIN merchant_users mu ON mu.id = s.merchant_user_id WHERE mu.merchant_id = $1 AND mu.email = $2`,
    [company.merchantId, email],
  );
  assert.equal(sessions.rows.length, 0);

  const wrong = await login(email, "wrong-password-123");
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "invalid_credentials");
});

test("approve: owner approves (role override), staff can then sign in, email goes to staff", async () => {
  const company = await approvedCompany("approve");
  const email = `ap-${randomUUID()}@staff.test`;
  assert.equal((await join(company.code, email, { requestedRole: "finance" })).statusCode, 201);
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const row = await staffRow(company.merchantId, email);

  const list = await app.inject({ method: "GET", url: "/v1/team", cookies: as(owner) });
  assert.equal(list.statusCode, 200, list.body);
  const members = list.json().members as Array<Record<string, unknown>>;
  const pending = members.find((m) => m.id === row.id)!;
  assert.deepEqual(Object.keys(pending).sort(), ["approvedAt", "createdAt", "email", "fullName", "id", "requestedRole", "role", "status"]);
  assert.equal(pending.status, "pending_owner_approval");
  assert.equal(members[0]!.role, "owner", "owner is listed first");

  sent = [];
  const approve = await app.inject({ method: "POST", url: `/v1/team/${row.id}/approve`, cookies: as(owner), payload: { role: "support" } });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().status, "active");
  assert.equal(approve.json().role, "support");

  const after = await staffRow(company.merchantId, email);
  assert.equal(after.status, "active");
  assert.equal(after.role, "support");
  assert.equal(after.approved_by_user_id, company.ownerUserId);
  assert.ok(after.approved_at);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, email);
  assert.ok(sent[0]!.text.includes("approved"));

  const again = await app.inject({ method: "POST", url: `/v1/team/${row.id}/approve`, cookies: as(owner) });
  assert.equal(again.statusCode, 409);

  const staffToken = await signIn(email, STAFF_PW);
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(staffToken) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, "support");
  assert.equal(me.json().status, "active");
  assert.equal(me.json().fullName, "Sam Staff");
});

test("approve defaults to the requested role", async () => {
  const company = await approvedCompany("approve-default");
  const email = `def-${randomUUID()}@staff.test`;
  await join(company.code, email, { requestedRole: "finance" });
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const row = await staffRow(company.merchantId, email);
  const res = await app.inject({ method: "POST", url: `/v1/team/${row.id}/approve`, cookies: as(owner), payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().role, "finance");
  const email2 = `x-${randomUUID()}@staff.test`;
  assert.equal((await join(company.code, email2)).statusCode, 201);
  const badRow = await staffRow(company.merchantId, email2);
  const owned = await app.inject({ method: "POST", url: `/v1/team/${badRow.id}/approve`, cookies: as(owner), payload: { role: "owner" } });
  assert.equal(owned.statusCode, 400, "cannot approve someone as owner");
});

test("reject: the person cannot sign in, gets an email, and cannot be approved afterwards", async () => {
  const company = await approvedCompany("reject");
  const email = `rj-${randomUUID()}@staff.test`;
  await join(company.code, email);
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const row = await staffRow(company.merchantId, email);
  sent = [];

  const res = await app.inject({ method: "POST", url: `/v1/team/${row.id}/reject`, cookies: as(owner) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "rejected");
  assert.equal((await staffRow(company.merchantId, email)).status, "rejected");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, email);
  assert.ok(sent[0]!.text.includes("declined"));

  const attempt = await login(email, STAFF_PW);
  assert.equal(attempt.statusCode, 403);
  assert.equal(attempt.json().error, "account_disabled");
  const approve = await app.inject({ method: "POST", url: `/v1/team/${row.id}/approve`, cookies: as(owner) });
  assert.equal(approve.statusCode, 409);
  const reject2 = await app.inject({ method: "POST", url: `/v1/team/${row.id}/reject`, cookies: as(owner) });
  assert.equal(reject2.statusCode, 409);
});

test("approve/reject succeed even when the notification email fails", async () => {
  const company = await approvedCompany("decision-mailfail");
  const [e1, e2] = [`m1-${randomUUID()}@staff.test`, `m2-${randomUUID()}@staff.test`];
  await join(company.code, e1);
  await join(company.code, e2);
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  failMail = true;
  const r1 = await app.inject({ method: "POST", url: `/v1/team/${(await staffRow(company.merchantId, e1)).id}/approve`, cookies: as(owner) });
  const r2 = await app.inject({ method: "POST", url: `/v1/team/${(await staffRow(company.merchantId, e2)).id}/reject`, cookies: as(owner) });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal((await staffRow(company.merchantId, e1)).status, "active");
  assert.equal((await staffRow(company.merchantId, e2)).status, "rejected");
});

test("disable: sessions and pending sign-ins die immediately; enable lets the person back in", async () => {
  const company = await approvedCompany("disable");
  const staff = await activeStaff(company.merchantId, company.ownerUserId, "finance", "dis");
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const staffToken = await signIn(staff.email, STAFF_PW);
  // a second, still-pending (password-only) sign-in
  const pendingLogin = await login(staff.email, STAFF_PW);
  assert.equal(pendingLogin.statusCode, 200);
  const pendingToken = cookieOf(pendingLogin);
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(staffToken) })).statusCode, 200);

  const res = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { status: "disabled" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "disabled");

  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(staffToken) })).statusCode, 401);
  const verify = await app.inject({
    method: "POST", url: "/v1/auth/otp/verify", cookies: as(pendingToken), payload: { code: pendingLogin.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 401, "the pending sign-in can no longer finish");
  const live = await pool.query(`SELECT 1 FROM sessions WHERE merchant_user_id = $1 AND revoked_at IS NULL`, [staff.id]);
  assert.equal(live.rows.length, 0);

  const blocked = await login(staff.email, STAFF_PW);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, "account_disabled");
  // a disabled person cannot be role-changed without enabling first
  const roleOnly = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { role: "support" } });
  assert.equal(roleOnly.statusCode, 409);

  const enable = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { status: "active", role: "support" } });
  assert.equal(enable.statusCode, 200, enable.body);
  assert.equal(enable.json().role, "support");
  const back = await signIn(staff.email, STAFF_PW);
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(back) })).json().role, "support");
});

test("role change takes effect on the next request", async () => {
  const company = await approvedCompany("rolechange");
  const staff = await activeStaff(company.merchantId, company.ownerUserId, "finance", "rc");
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const staffToken = await signIn(staff.email, STAFF_PW);
  const res = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { role: "support" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(staffToken) })).json().role, "support");
  const bad = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { role: "owner" } });
  assert.equal(bad.statusCode, 400);
  const empty = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: {} });
  assert.equal(empty.statusCode, 400);
  const badStatus = await app.inject({ method: "PATCH", url: `/v1/team/${staff.id}`, cookies: as(owner), payload: { status: "rejected" } });
  assert.equal(badStatus.statusCode, 400);
});

test("owner cannot disable or change themselves, and nobody can touch an owner", async () => {
  const company = await approvedCompany("self");
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  for (const payload of [{ status: "disabled" }, { role: "support" }]) {
    const res = await app.inject({ method: "PATCH", url: `/v1/team/${company.ownerUserId}`, cookies: as(owner), payload });
    assert.equal(res.statusCode, 403, res.body);
  }
  // a second owner row (should never exist, but must still be untouchable)
  staffHash ??= await hashPassword(STAFF_PW, config);
  const other = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id`,
    [company.merchantId, `o2-${randomUUID()}@co.test`, staffHash],
  );
  const res = await app.inject({ method: "PATCH", url: `/v1/team/${other.rows[0]!.id}`, cookies: as(owner), payload: { status: "disabled" } });
  assert.equal(res.statusCode, 403);
  const rej = await app.inject({ method: "POST", url: `/v1/team/${company.ownerUserId}/reject`, cookies: as(owner) });
  assert.equal(rej.statusCode, 409, "an active owner is not a pending request");
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(owner) })).statusCode, 200);
});

test("a pending person cannot be role-changed or disabled through PATCH", async () => {
  const company = await approvedCompany("patch-pending");
  const email = `pp-${randomUUID()}@staff.test`;
  await join(company.code, email);
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const row = await staffRow(company.merchantId, email);
  const res = await app.inject({ method: "PATCH", url: `/v1/team/${row.id}`, cookies: as(owner), payload: { status: "active" } });
  assert.equal(res.statusCode, 409);
  assert.equal((await staffRow(company.merchantId, email)).status, "pending_owner_approval");
});

// ------------------------------------------------------------ authorization

test("team routes are owner-only: finance, support, API keys and anonymous callers are refused", async () => {
  const company = await approvedCompany("authz");
  const fin = await activeStaff(company.merchantId, company.ownerUserId, "finance", "fin");
  const sup = await activeStaff(company.merchantId, company.ownerUserId, "support", "sup");
  const finToken = await signIn(fin.email, STAFF_PW);
  const supToken = await signIn(sup.email, STAFF_PW);
  const key = await issueApiKey(pool, config, { merchantId: company.merchantId, createdBy: company.ownerUserId, label: "k" });
  const pendingEmail = `az-${randomUUID()}@staff.test`;
  await join(company.code, pendingEmail);
  const target = (await staffRow(company.merchantId, pendingEmail)).id;

  const calls: Array<{ method: "GET" | "POST" | "PATCH"; url: string; payload?: object }> = [
    { method: "GET", url: "/v1/team" },
    { method: "POST", url: `/v1/team/${target}/approve`, payload: {} },
    { method: "POST", url: `/v1/team/${target}/reject` },
    { method: "PATCH", url: `/v1/team/${fin.id}`, payload: { status: "disabled" } },
  ];
  for (const call of calls) {
    for (const token of [finToken, supToken]) {
      const res = await app.inject({ ...call, cookies: as(token) });
      assert.equal(res.statusCode, 403, `${call.method} ${call.url}: ${res.body}`);
    }
    const apiKey = await app.inject({ ...call, headers: { authorization: `Bearer ${key.rawKey}` } });
    assert.equal(apiKey.statusCode, 401, `API key ${call.method} ${call.url}`);
    const anon = await app.inject({ ...call });
    assert.equal(anon.statusCode, 401);
  }
  // nothing changed
  assert.equal((await staffRow(company.merchantId, pendingEmail)).status, "pending_owner_approval");
  const finRow = await pool.query<{ status: string }>(`SELECT status FROM merchant_users WHERE id = $1`, [fin.id]);
  assert.equal(finRow.rows[0]!.status, "active");
});

test("team: another company's user id is a 404 for approve, reject and patch, and never listed", async () => {
  const mine = await approvedCompany("idor-mine");
  const theirs = await approvedCompany("idor-theirs");
  const theirEmail = `tp-${randomUUID()}@staff.test`;
  await join(theirs.code, theirEmail);
  const theirActive = await activeStaff(theirs.merchantId, theirs.ownerUserId, "finance", "tf");
  const theirPendingId = (await staffRow(theirs.merchantId, theirEmail)).id;
  const owner = await signIn(mine.ownerEmail, OWNER_PW);

  for (const call of [
    { method: "POST" as const, url: `/v1/team/${theirPendingId}/approve` },
    { method: "POST" as const, url: `/v1/team/${theirPendingId}/reject` },
    { method: "PATCH" as const, url: `/v1/team/${theirActive.id}`, payload: { status: "disabled" } },
    { method: "PATCH" as const, url: `/v1/team/${theirs.ownerUserId}`, payload: { status: "disabled" } },
    { method: "PATCH" as const, url: `/v1/team/not-a-uuid`, payload: { status: "disabled" } },
  ]) {
    const res = await app.inject({ ...call, cookies: as(owner) });
    assert.equal(res.statusCode, 404, `${call.url}: ${res.body}`);
  }
  assert.equal((await staffRow(theirs.merchantId, theirEmail)).status, "pending_owner_approval");

  const list = await app.inject({ method: "GET", url: "/v1/team", cookies: as(owner) });
  const ids = (list.json().members as Array<{ id: string }>).map((m) => m.id);
  assert.ok(ids.includes(mine.ownerUserId));
  assert.ok(!ids.includes(theirPendingId) && !ids.includes(theirActive.id) && !ids.includes(theirs.ownerUserId));
});

// ------------------------------------------------------------ payment links + /me

test("payment links need an approved company (403 merchant_not_approved), then work", async () => {
  const company = await createCompany("links");
  const owner = await signIn(company.ownerEmail, OWNER_PW);
  const body = { amountFils: 4_750, reference: "o-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const url = `/v1/merchants/${company.merchantId}/payment-links`;

  const blocked = await app.inject({ method: "POST", url, cookies: as(owner), payload: body });
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().error, "merchant_not_approved");

  const key = await issueApiKey(pool, config, { merchantId: company.merchantId, createdBy: company.ownerUserId, label: "k" });
  const blockedKey = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key.rawKey}` }, payload: body });
  assert.equal(blockedKey.statusCode, 403);
  assert.equal(blockedKey.json().error, "merchant_not_approved");

  await adminReview(company.merchantId, "approved");
  const ok = await app.inject({ method: "POST", url, cookies: as(owner), payload: body });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("/me returns companyCode only for an approved company's owner", async () => {
  const pendingCompany = await createCompany("me-pending");
  const pendingOwner = await signIn(pendingCompany.ownerEmail, OWNER_PW);
  const before = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(pendingOwner) });
  assert.equal(before.statusCode, 200);
  assert.ok(!("companyCode" in before.json()));
  assert.equal(before.json().merchant.onboardingStatus, "submitted");
  assert.equal(before.json().status, "active");
  assert.equal(before.json().fullName, "Olivia Owner");

  await adminReview(pendingCompany.merchantId, "approved");
  const after = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(pendingOwner) });
  assert.equal(after.json().companyCode, await codeOf(pendingCompany.merchantId));
  assert.equal(after.json().role, "owner");
  assert.ok(after.json().merchant.id && after.json().email, "existing fields are kept");

  const staff = await activeStaff(pendingCompany.merchantId, pendingCompany.ownerUserId, "finance", "me");
  const staffToken = await signIn(staff.email, STAFF_PW);
  const staffMe = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: as(staffToken) });
  assert.equal(staffMe.statusCode, 200);
  assert.ok(!("companyCode" in staffMe.json()), "staff never see the company ID");
});
