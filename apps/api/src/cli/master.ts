import readline from "node:readline";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";

// Use the same email settings as the API container (ops/.env.mail, git-ignored).
// Values already present in the environment win.
dotenv.config({ path: new URL("../../../../ops/.env.mail", import.meta.url).pathname, quiet: true });
import { createPool } from "../db/pool.js";
import { createMaster, MIN_PASSWORD_LENGTH, resetMaster } from "./masterAccount.js";

/**
 * Server-side command for the single master admin account.
 *
 *   npm run master:create -- --email boss@example.com [--name "Boss"] [--setup-email]
 *   npm run master:reset  [-- --setup-email]
 *
 * Password: typed at a hidden prompt, or taken from MASTER_PASSWORD (for
 * non-interactive use). With --setup-email no password is typed at all: a
 * one-time link is emailed and the owner chooses the password there.
 * The password is never printed.
 */
function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const writable = rl as unknown as { _writeToOutput: (text: string) => void };
    const original = writable._writeToOutput.bind(rl);
    writable._writeToOutput = (text: string) => {
      if (!muted || text === "\r\n" || text === "\n") original(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword(confirm: boolean): Promise<string> {
  const fromEnv = process.env.MASTER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error("No terminal for a hidden prompt. Set MASTER_PASSWORD, or use --setup-email.");
  }
  const first = await promptHidden(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (confirm) {
    const second = await promptHidden("Repeat the password: ");
    if (first !== second) throw new Error("The two passwords do not match.");
  }
  return first;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command !== "create" && command !== "reset") {
    console.error('Usage: master:create -- --email <address> [--name <name>] [--setup-email]\n       master:reset [-- --setup-email]');
    process.exit(2);
  }
  const config = loadConfig(process.env);
  const pool = createPool(config);
  try {
    const sendSetupEmail = flags.get("setup-email") === true;
    const password = sendSetupEmail ? undefined : await readPassword(command === "create");
    const emailFlag = typeof flags.get("email") === "string" ? (flags.get("email") as string) : undefined;
    const nameFlag = typeof flags.get("name") === "string" ? (flags.get("name") as string) : undefined;

    if (command === "create") {
      if (!emailFlag) throw new Error("--email is required.");
      const result = await createMaster(pool, config, { email: emailFlag, displayName: nameFlag, password, sendSetupEmail });
      console.log(`Master account created for ${result.email}.`);
      if (sendSetupEmail) {
        console.log(
          result.setupEmailSent
            ? `A link to choose the password was emailed to ${result.email} (valid 48 hours).`
            : 'The account exists but the setup email could not be sent. Fix the mail settings, then run "npm run master:reset -- --setup-email".',
        );
      }
    } else {
      const result = await resetMaster(pool, config, { email: emailFlag, password, sendSetupEmail });
      console.log(`Master account ${result.email} updated; all its sessions were signed out.`);
      if (sendSetupEmail) {
        console.log(result.setupEmailSent ? "A new setup link was emailed." : "The setup email could not be sent.");
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
