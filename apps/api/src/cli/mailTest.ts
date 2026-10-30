import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { resolveMailProviders, sendWithProvider } from "../lib/mail.js";
import { otpEmail } from "../lib/mailTemplates.js";

// Same settings as the API container (ops/.env.mail locally; real environment on the server).
dotenv.config({ path: new URL("../../../../ops/.env.mail", import.meta.url).pathname, quiet: true });

/**
 *   npm run mail:test -- --to you@example.com
 * Sends a test message through EACH configured provider separately and reports which ones work,
 * so a broken provider cannot hide behind the fallback. The message contains no real code.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--to");
  const to = (i >= 0 ? argv[i + 1] : undefined) ?? "fils.pay01@gmail.com";
  const config = loadConfig(process.env);
  const providers = resolveMailProviders(config);
  if (providers.length === 0) {
    console.error("No email provider is configured (set RESEND_API_KEY + OTP_FROM_EMAIL, or SMTP_HOST + MAIL_FROM).");
    process.exit(1);
  }
  console.log(`Providers in the order they are tried: ${providers.join(" -> ")}`);
  let anyOk = false;
  for (const provider of providers) {
    const message = { ...otpEmail(to, "000000", "admin", 5), subject: `FilsPay email test via ${provider} (ignore)` };
    try {
      await sendWithProvider(provider, config, message);
      anyOk = true;
      console.log(`OK    ${provider}: accepted a test message for ${to}`);
    } catch (err) {
      console.log(`FAIL  ${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(anyOk ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
