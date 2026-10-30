import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, test } from "node:test";
import { mailFromAddress, resolveMailProviders, sendMail, type MailConfig } from "./mail.js";

const msg = { to: "someone@example.test", subject: "S", text: "T" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal local SMTP server (no TLS, no auth) that records the envelope. */
function startSmtp(): Promise<{ port: number; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server = net.createServer((sock) => {
    sock.write("220 test ESMTP\r\n");
    let buf = "", inData = false;
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString();
      for (;;) {
        if (inData) {
          const i = buf.indexOf("\r\n.\r\n");
          if (i < 0) return;
          buf = buf.slice(i + 5); inData = false; sock.write("250 queued\r\n"); continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-test\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL" || cmd === "RCPT") { seen.push(line); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); return; }
        else sock.write("250 OK\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() })),
  );
}

const both = (smtpPort: number, mailProvider: MailConfig["mailProvider"]): MailConfig => ({
  otpEmailApiKey: "re_test_key",
  otpFromEmail: "FilsPay <onboarding@resend.dev>",
  smtpHost: "127.0.0.1",
  smtpPort,
  smtpSecure: false,
  mailFrom: "FilsPay <sender@gmail.test>",
  mailProvider,
});

test("order: auto = Resend first; smtp preferred = SMTP first; a provider that is not configured is skipped", () => {
  assert.deepEqual(resolveMailProviders(both(25, "auto")), ["resend", "smtp"]);
  assert.deepEqual(resolveMailProviders(both(25, undefined)), ["resend", "smtp"]);
  assert.deepEqual(resolveMailProviders(both(25, "smtp")), ["smtp", "resend"]);
  assert.deepEqual(resolveMailProviders({ ...both(25, "smtp"), smtpHost: undefined }), ["resend"]);
  assert.deepEqual(resolveMailProviders({ ...both(25, "smtp"), otpEmailApiKey: undefined }), ["smtp"]);
});

test("each provider uses its own From address", () => {
  const c = both(25, "smtp");
  assert.equal(mailFromAddress(c, "resend"), "FilsPay <onboarding@resend.dev>");
  assert.equal(mailFromAddress(c, "smtp"), "FilsPay <sender@gmail.test>");
});

test("SMTP preferred and working: delivers over SMTP and never calls Resend", async () => {
  const smtp = await startSmtp();
  let resendCalled = false;
  globalThis.fetch = (async () => { resendCalled = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    const used = await sendMail(both(smtp.port, "smtp"), msg);
    assert.equal(used, "smtp");
    assert.equal(resendCalled, false);
    assert.ok(smtp.seen.some((l) => /RCPT TO:<someone@example.test>/i.test(l)));
    assert.ok(smtp.seen.some((l) => /MAIL FROM:<sender@gmail.test>/i.test(l)), "SMTP must use MAIL_FROM, not the Resend sender");
  } finally { smtp.close(); }
});

test("SMTP preferred but down: falls back to Resend, with Resend's own From address", async () => {
  let body: { from?: string } = {};
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  // port 1 on localhost: connection refused
  const used = await sendMail(both(1, "smtp"), msg);
  assert.equal(used, "resend");
  assert.equal(body.from, "FilsPay <onboarding@resend.dev>");
});

test("Resend preferred but refuses the address: falls back to SMTP", async () => {
  const smtp = await startSmtp();
  globalThis.fetch = (async () => new Response('{"message":"only your own address"}', { status: 403 })) as typeof fetch;
  try {
    assert.equal(await sendMail(both(smtp.port, "auto"), msg), "smtp");
  } finally { smtp.close(); }
});

test("both fail: one error that names both providers", async () => {
  globalThis.fetch = (async () => new Response('{"message":"nope"}', { status: 403 })) as typeof fetch;
  await assert.rejects(() => sendMail(both(1, "smtp"), msg), (err: Error) => {
    assert.match(err.message, /All email providers failed/);
    assert.match(err.message, /smtp:/);
    assert.match(err.message, /resend:/);
    assert.ok(!err.message.includes("re_test_key"));
    return true;
  });
});

test("SMTP with a login refuses an unencrypted connection (credentials are never sent in clear)", async () => {
  const smtp = await startSmtp(); // offers no STARTTLS
  try {
    const cfg: MailConfig = { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpUser: "user", smtpPass: "pass", mailFrom: "a@b.test" };
    await assert.rejects(() => sendMail(cfg, msg), /STARTTLS|TLS|secure/i);
    assert.equal(smtp.seen.length, 0, "no message may be transmitted");
  } finally { smtp.close(); }
});
