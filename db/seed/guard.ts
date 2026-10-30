/**
 * Safety guard + reset helpers for the demo-data seed. Kept free of any
 * database access in assertSeedAllowed() so it can run before the first
 * statement (and before any connection is opened).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hosts the seed may touch: loopback, plus the compose service name of the
// local postgres (ops/docker-compose.yml, service `postgres`).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "development" && env.SEED_ALLOW !== "1") {
    throw new Error(
      "seed: refusing to run. The seed is destructive dev tooling; set NODE_ENV=development " +
        "(or SEED_ALLOW=1) and point DATABASE_URL at a local database.",
    );
  }
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error("seed: DATABASE_URL environment variable is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("seed: refusing to run: DATABASE_URL is not a parseable URL");
  }
  // libpq-style ?host= overrides the authority; check it too (unix sockets are local).
  const hosts = [url.hostname, ...(url.searchParams.get("host") ? [url.searchParams.get("host")!] : [])];
  for (const h of hosts) {
    if (!LOCAL_HOSTS.has(h.toLowerCase()) && !h.startsWith("/")) {
      throw new Error(
        `seed: refusing to run against non-local database host '${h}'. ` +
          "Allowed hosts: localhost, 127.0.0.1, ::1, postgres (docker compose).",
      );
    }
  }
}

/** True when the database already holds seed-relevant data. */
export async function isDatabaseNonEmpty(pool: Pool): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM merchants) + (SELECT count(*) FROM ledger_entries)
          + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM admin_users) + (SELECT count(*) FROM outbox_events) AS n`,
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

/**
 * Wipes the database by recreating the public schema, then re-applies every
 * migration via db/migrate.ts. ledger_entries is append-only (migration 0078
 * blocks UPDATE/DELETE/TRUNCATE and offers no bypass), so dropping the schema
 * is the only reset that leaves the trigger protection intact.
 */
export async function resetDatabase(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  assertSeedAllowed(env);
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO PUBLIC");
  execFileSync("npx", ["tsx", join(__dirname, "..", "migrate.ts")], {
    env: { ...env },
    cwd: join(__dirname, "..", ".."),
    stdio: ["ignore", "ignore", "inherit"],
  });
}
