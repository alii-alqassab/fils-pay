import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { resolveMailProvider } from "./lib/mail.js";
import { createPool } from "./db/pool.js";
import { markDbConnectedOnce } from "./health/state.js";
import { formatIsoDate } from "./lib/dateFormat.js";
import { startWebhookDispatcher, type WebhookDispatcherHandle } from "./webhooks/dispatcher.js";
import { createFetchTransport } from "./webhooks/transport.js";

const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  // An unset NODE_ENV would silently run with development defaults (OTP returned in the
  // login response, SSRF guard off, cookies not Secure). The process entrypoint refuses it.
  if (!process.env.NODE_ENV) {
    throw new Error("NODE_ENV must be set explicitly (production, development or test)");
  }
  const config = loadConfig(process.env);
  console.log(`[index] booting, date=${formatIsoDate(new Date())}`);
  // Sign-in codes are emailed by default. Say clearly, once, if that cannot work.
  if (config.otpDelivery === "email") {
    const provider = resolveMailProvider(config);
    if (provider) {
      console.log(`[index] sign-in codes are sent by email (${provider})`);
    } else {
      // Fail closed but keep serving: sign-in answers 503 (otp_delivery_unavailable) until a
      // provider is configured, while public pages (checkout, registration, callbacks) keep working.
      console.error(
        "[index] WARNING: no email sender is configured, so NOBODY CAN SIGN IN (the sign-in code is emailed). " +
          "Set RESEND_API_KEY + OTP_FROM_EMAIL, or SMTP_HOST + MAIL_FROM (see ops/.env.mail.example).",
      );
    }
  }
  const pool = createPool(config);
  // One transport per process: the dispatcher's background pass and the
  // merchant-facing "send test event" route both run on this same instance.
  const webhookTransport = createFetchTransport(config);
  const app = buildApp(config, pool, { webhookTransport });

  // Fail fast if the DB is unreachable at boot.
  await pool.query("SELECT 1");
  markDbConnectedOnce();

  // YA: 0.0.0.0 is required inside docker. not a finding
  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Started explicitly here, after app.listen() — never inside buildApp()
  // (see webhooks/dispatcher.ts): buildApp()'s whole value is that it
  // returns a non-listening instance every route test's app.inject(...)
  // uses with no live background LISTEN session or timer wanted.
  // MK: one dispatcher per replica. SKIP LOCKED in the claim query makes multiple replicas safe
  // am: we only run one replica anyway (512mb). fine
  const dispatcher: WebhookDispatcherHandle = startWebhookDispatcher(pool, webhookTransport, config);

  let shuttingDown = false;
  /**
   * Graceful shutdown: stop the dispatcher (waits for the in-flight pass),
   * then stop accepting HTTP, then drain the pool. Order matters — the pool
   * must outlive both.
   */
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] received ${signal}, shutting down`);
    let exitCode = 0;
    // A hung in-flight request or delivery must not keep the process alive forever.
    const forceExit = setTimeout(() => {
      console.error("[index] shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    dispatcher
      .stop()
      .then(() => app.close())
      .then(() => pool.end())
      .catch((err: unknown) => {
        exitCode = 1;
        console.error("[index] error during shutdown", err);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
