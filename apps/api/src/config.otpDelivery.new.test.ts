import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://x/y?sslmode=disable",
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};
const prod = {
  ...base,
  NODE_ENV: "production",
  DATABASE_URL: "postgres://x/y?sslmode=require",
  SETTLEMENT_INTERNAL_TOKEN: "a-real-token-value",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
};

test("tests log the code and expose it; every other environment emails it and exposes nothing", () => {
  const t = loadConfig({ ...base, NODE_ENV: "test" });
  assert.equal(t.otpDelivery, "log");
  assert.equal(t.otpDevExpose, true);

  const d = loadConfig({ ...base, NODE_ENV: "development" });
  assert.equal(d.otpDelivery, "email");
  assert.equal(d.otpDevExpose, false);

  const unset = loadConfig({ ...base });
  assert.equal(unset.otpDelivery, "email");
  assert.equal(unset.otpDevExpose, false);
});

test("local development can opt in to logged codes explicitly", () => {
  const d = loadConfig({ ...base, NODE_ENV: "development", OTP_DELIVERY: "log" });
  assert.equal(d.otpDelivery, "log");
  assert.equal(d.otpDevExpose, true);
});

test("production always emails and refuses log delivery", () => {
  assert.equal(loadConfig(prod).otpDelivery, "email");
  assert.equal(loadConfig(prod).otpDevExpose, false);
  assert.throws(() => loadConfig({ ...prod, OTP_DELIVERY: "log" }), /OTP_DELIVERY=log is not allowed/);
});

test("an unknown OTP_DELIVERY value is rejected", () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "development", OTP_DELIVERY: "sms" }), /must be "email" or "log"/);
});

test("SMTP and link settings are read, with sensible defaults", () => {
  const c = loadConfig({
    ...base,
    NODE_ENV: "development",
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    MAIL_FROM: "FilsPay <a@b.test>",
    ADMIN_CONSOLE_URL: "https://admin.example.test/",
  });
  assert.equal(c.smtpHost, "smtp.example.test");
  assert.equal(c.smtpPort, 587);
  assert.equal(c.smtpSecure, false);
  assert.equal(c.mailFrom, "FilsPay <a@b.test>");
  assert.equal(c.adminConsoleUrl, "https://admin.example.test");
  assert.equal(c.dashboardUrl, "http://localhost:5173");
});

test("blank mail variables count as not set", () => {
  const c = loadConfig({ ...base, NODE_ENV: "development", RESEND_API_KEY: "", OTP_FROM_EMAIL: "", SMTP_HOST: "" });
  assert.equal(c.otpEmailApiKey, undefined);
  assert.equal(c.otpFromEmail, undefined);
  assert.equal(c.smtpHost, undefined);
});

test("MAIL_PROVIDER: auto by default, smtp/resend accepted, anything else rejected", () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: "development" }).mailProvider, "auto");
  assert.equal(loadConfig({ ...base, NODE_ENV: "development", MAIL_PROVIDER: "SMTP" }).mailProvider, "smtp");
  assert.equal(loadConfig({ ...base, NODE_ENV: "development", MAIL_PROVIDER: "resend" }).mailProvider, "resend");
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "development", MAIL_PROVIDER: "sendgrid" }), /MAIL_PROVIDER must be/);
});
