import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  MailNotConfiguredError,
  resolveMailProvider,
  sendMail,
  sendMailQuietly,
  setMailTransportForTests,
  type MailConfig,
} from "./mail.js";
import { adminInviteEmail, companyApprovedEmail, joinRequestEmail, otpEmail } from "./mailTemplates.js";

afterEach(() => setMailTransportForTests(null));

const none: MailConfig = {};
const resend: MailConfig = { otpEmailApiKey: "re_test", otpFromEmail: "FilsPay <a@b.test>" };
const smtp: MailConfig = { smtpHost: "smtp.example.test", smtpPort: 587, mailFrom: "FilsPay <a@b.test>" };

test("provider: nothing configured -> null; resend; smtp; resend wins when both", () => {
  assert.equal(resolveMailProvider(none), null);
  assert.equal(resolveMailProvider(resend), "resend");
  assert.equal(resolveMailProvider(smtp), "smtp");
  assert.equal(resolveMailProvider({ ...resend, ...smtp }), "resend");
});

test("provider: a key or host without a From address is not enough", () => {
  assert.equal(resolveMailProvider({ otpEmailApiKey: "re_test" }), null);
  assert.equal(resolveMailProvider({ smtpHost: "smtp.example.test" }), null);
});

test("sendMail with no configuration throws a clear error and sendMailQuietly only logs it", async () => {
  await assert.rejects(() => sendMail(none, { to: "x@y.test", subject: "s", text: "t" }), MailNotConfiguredError);
  const warnings: string[] = [];
  const ok = await sendMailQuietly(none, { to: "x@y.test", subject: "s", text: "t" }, { warn: (_o, m) => void warnings.push(m) });
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
});

test("the test transport captures messages instead of sending", async () => {
  const sent: string[] = [];
  setMailTransportForTests(async (m) => void sent.push(m.subject));
  await sendMail(none, { to: "x@y.test", subject: "hello", text: "t" });
  assert.deepEqual(sent, ["hello"]);
});

test("Resend request: Bearer key, from, to, subject, html; non-2xx becomes an error without leaking the key", async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => sendMail(resend, { to: "who@x.test", subject: "S", text: "T", html: "<p>T</p>" }),
      (err: Error) => {
        assert.match(err.message, /403/);
        assert.ok(!err.message.includes("re_test"));
        return true;
      },
    );
    assert.equal(seen!.url, "https://api.resend.com/emails");
    const body = JSON.parse(String(seen!.init.body));
    assert.deepEqual(body.to, ["who@x.test"]);
    assert.equal(body.from, "FilsPay <a@b.test>");
    assert.equal(body.html, "<p>T</p>");
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer re_test");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OTP email contains the code, the audience and the lifetime; the subject shows the code", () => {
  const m = otpEmail("u@x.test", "123456", "admin", 5);
  assert.equal(m.to, "u@x.test");
  assert.match(m.subject, /123456/);
  assert.match(m.text, /123456/);
  assert.match(m.text, /admin console/);
  assert.match(m.text, /5 minutes/);
});

test("templates HTML-escape user-supplied names", () => {
  const evil = `<script>alert(1)</script>`;
  const html = [
    joinRequestEmail("o@x.test", { ownerName: "O", companyName: "C", staffName: evil, staffEmail: "s@x.test", role: "support", teamUrl: "http://t" }).html,
    companyApprovedEmail("o@x.test", { ownerName: evil, companyName: evil, companyCode: "FP-AAAA-BBBB", dashboardUrl: "http://d" }).html,
    adminInviteEmail("a@x.test", { displayName: evil, role: "finance", link: "http://l?x=1&y=2", hours: 48, purpose: "invite" }).html,
  ].join("\n");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("company approval email carries the company ID and the join page", () => {
  const m = companyApprovedEmail("o@x.test", { ownerName: "Owner", companyName: "Acme", companyCode: "FP-7K3M-9QXA", dashboardUrl: "http://localhost:5173" });
  assert.match(m.text, /FP-7K3M-9QXA/);
  assert.match(m.text, /\/dashboard\/join/);
});
