/**
 * Retention for `idempotency_keys`: deletes finished (completed or failed) keys
 * older than RETAIN_DAYS. In-progress keys are never touched. A replay of a key
 * older than the retention window is treated as a new request, so keep the
 * window well beyond any client's retry horizon.
 *
 * Usage: DATABASE_URL=... tsx scripts/purge_idempotency_keys.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const RETAIN_DAYS = 30;

export async function purgeIdempotencyKeys(client: Client, retainDays: number = RETAIN_DAYS): Promise<number> {
  const result = await client.query(
    `DELETE FROM idempotency_keys
      WHERE status IN ('completed', 'failed')
        AND created_at < now() - make_interval(days => $1::int)`,
    [retainDays],
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("purge_idempotency_keys: DATABASE_URL environment variable is not set");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(`purge_idempotency_keys: deleted ${await purgeIdempotencyKeys(client)} key(s)`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
