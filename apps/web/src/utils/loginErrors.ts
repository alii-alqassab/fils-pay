import { tk } from "../i18n/translate.js";

/**
 * Friendly text for the sign-in errors the API sends. The API refuses staff
 * who may not sign in only AFTER their password was right (403), so these
 * messages are safe to be specific. Returns null when the generic error text
 * should be used. Kept free of imports so it can be unit tested without a browser.
 */
export function loginErrorMessage(code: string, statusCode: number): string | null {
  if (code === "account_pending_owner_approval") {
    return tk("Your request is waiting for your company owner to approve it. You can sign in after that.");
  }
  if (code === "account_disabled") {
    return tk("This account cannot sign in. Please contact your company owner.");
  }
  if (code === "otp_delivery_unavailable") {
    return tk("We could not send the sign-in code by email. Please try again in a moment.");
  }
  if (statusCode === 401 && code === "invalid_credentials") {
    return tk("Email or password is not correct.");
  }
  return null;
}
