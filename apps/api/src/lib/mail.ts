import { createTransport } from "nodemailer";
import type { Config } from "../config.js";

/**
 * Outgoing email for sign-in codes, admin invitations and account notices.
 *
 * Two providers, chosen by configuration (Resend wins when both are set):
 *   - Resend: RESEND_API_KEY + OTP_FROM_EMAIL (or MAIL_FROM)
 *   - SMTP:   SMTP_HOST (+ SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE) + MAIL_FROM
 * With neither configured, sending throws MailNotConfiguredError; callers decide
 * whether that is fatal (sign-in codes) or only worth a log line (notices).
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailConfig = Pick<
  Config,
  "otpEmailApiKey" | "otpFromEmail" | "smtpHost" | "smtpPort" | "smtpUser" | "smtpPass" | "smtpSecure" | "mailFrom"
> &
  Partial<Pick<Config, "mailProvider">>;

export type MailProvider = "resend" | "smtp";

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      "Email delivery is not configured. Set RESEND_API_KEY and OTP_FROM_EMAIL, or SMTP_HOST and MAIL_FROM " +
        "(see ops/.env.mail.example).",
    );
    this.name = "MailNotConfiguredError";
  }
}

/** The From address for one provider. Resend only accepts its own or a verified-domain
 *  address (OTP_FROM_EMAIL); SMTP uses MAIL_FROM (the address verified with the SMTP service). */
export function mailFromAddress(
  config: Pick<MailConfig, "mailFrom" | "otpFromEmail">,
  provider?: MailProvider,
): string | undefined {
  if (provider === "resend") return config.otpFromEmail || config.mailFrom || undefined;
  return config.mailFrom || config.otpFromEmail || undefined;
}

/** Configured providers in the order they are tried (the first is the preferred one). */
export function resolveMailProviders(config: MailConfig): MailProvider[] {
  const resend = Boolean(config.otpEmailApiKey && mailFromAddress(config, "resend"));
  const smtp = Boolean(config.smtpHost && mailFromAddress(config, "smtp"));
  const order: MailProvider[] = config.mailProvider === "smtp" ? ["smtp", "resend"] : ["resend", "smtp"];
  return order.filter((p) => (p === "resend" ? resend : smtp));
}

/** The preferred provider, or null when none is configured. */
export function resolveMailProvider(config: MailConfig): MailProvider | null {
  return resolveMailProviders(config)[0] ?? null;
}

type TestTransport = (message: MailMessage) => Promise<void>;
let testTransport: TestTransport | null = null;

/** Tests only: capture messages instead of sending them. Pass null to restore. */
export function setMailTransportForTests(transport: TestTransport | null): void {
  testTransport = transport;
}

export async function sendWithProvider(provider: MailProvider, config: MailConfig, message: MailMessage): Promise<void> {
  const from = mailFromAddress(config, provider)!;
  if (provider === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.otpEmailApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Resend's error body is a short JSON explanation (e.g. unverified
      // domain); it never echoes the API key.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Resend rejected the email (${response.status}) ${detail}`.trim());
    }
    return;
  }

  const transporter = createTransport({
    host: config.smtpHost,
    port: config.smtpPort ?? 587,
    secure: config.smtpSecure ?? false,
    // When a login is configured, never send it over an unencrypted connection.
    requireTLS: Boolean(config.smtpUser) && !config.smtpSecure,
    ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPass ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  } finally {
    transporter.close();
  }
}

/** Sends one email with the preferred provider and, if that fails and another provider is
 *  configured, with the next one. Resolves to the provider that delivered it. */
export async function sendMail(config: MailConfig, message: MailMessage): Promise<MailProvider> {
  if (testTransport) {
    await testTransport(message);
    return "smtp";
  }
  const providers = resolveMailProviders(config);
  if (providers.length === 0) {
    throw new MailNotConfiguredError();
  }
  const failures: string[] = [];
  let firstError: unknown;
  for (const provider of providers) {
    try {
      await sendWithProvider(provider, config, message);
      return provider;
    } catch (err) {
      firstError ??= err;
      failures.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (providers.length === 1) throw firstError;
  throw new Error(`All email providers failed (${failures.join(" | ")})`);
}

/** Fire-and-forget for notices that must never block or fail the action that
 *  triggered them. Failures are logged (never thrown). */
export async function sendMailQuietly(
  config: MailConfig,
  message: MailMessage,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<boolean> {
  try {
    await sendMail(config, message);
    return true;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), subject: message.subject }, "notice email failed");
    return false;
  }
}
