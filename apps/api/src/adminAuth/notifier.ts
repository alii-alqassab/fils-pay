import type { Config } from "../config.js";
import { effectiveOtpDelivery, sendOtpEmail, type MinimalLogger } from "../auth/notifier.js";
import type { MailConfig } from "../lib/mail.js";

/**
 * Admin sign-in codes use the same delivery path as merchant codes: a real
 * email by default, logged only when OTP_DELIVERY=log (tests).
 */
export async function sendAdminOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv"> & MailConfig & Partial<Pick<Config, "otpDelivery" | "adminOtpTtlMinutes">>,
  recipient: { adminUserId: string; email: string },
  code: string,
): Promise<void> {
  if (effectiveOtpDelivery(config) === "email") {
    await sendOtpEmail(
      { ...config, otpTtlMinutes: config.adminOtpTtlMinutes },
      recipient.email,
      code,
      undefined,
      "admin",
    );
    logger.info({ adminUserId: recipient.adminUserId, channel: "admin_otp" }, "admin otp email sent");
  } else {
    logger.info(
      { adminUserId: recipient.adminUserId, channel: "admin_otp", code },
      "admin otp code generated (log delivery)",
    );
  }
}
