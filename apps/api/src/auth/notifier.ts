import type { Config } from "../config.js";
import { sendMail, type MailConfig } from "../lib/mail.js";
import { otpEmail } from "../lib/mailTemplates.js";

/**
 * Sign-in codes are sent by real email by default (OTP_DELIVERY=email). The
 * code is only printed to the log when delivery is explicitly "log"
 * (automated tests, or local use that opts in), and is never logged when it
 * is emailed.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

type OtpConfig = Pick<Config, "nodeEnv"> & MailConfig & Partial<Pick<Config, "otpDelivery" | "otpTtlMinutes">>;

/** Hand-built Config fixtures without `otpDelivery` keep the old rule:
 *  production emails, everything else logs. */
export function effectiveOtpDelivery(config: Pick<Config, "nodeEnv"> & Partial<Pick<Config, "otpDelivery">>): "email" | "log" {
  return config.otpDelivery ?? (config.nodeEnv === "production" ? "email" : "log");
}

export async function sendOtpCode(
  logger: MinimalLogger,
  config: OtpConfig,
  recipient: { merchantUserId: string; email: string },
  code: string,
): Promise<void> {
  if (effectiveOtpDelivery(config) === "email") {
    await sendOtpEmail(config, recipient.email, code, undefined, "merchant");
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp email sent");
  } else {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (log delivery)",
    );
  }
}

/** Sends one sign-in code by email. `subject` is kept for older callers; the
 *  default subject contains the code so it is visible in the inbox preview. */
export async function sendOtpEmail(
  config: MailConfig & Partial<Pick<Config, "otpTtlMinutes">>,
  recipientEmail: string,
  code: string,
  subject?: string,
  audience: "merchant" | "admin" = "merchant",
): Promise<void> {
  const message = otpEmail(recipientEmail, code, audience, config.otpTtlMinutes ?? 5);
  await sendMail(config, subject ? { ...message, subject } : message);
}
