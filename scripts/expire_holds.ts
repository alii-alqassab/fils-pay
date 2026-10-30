#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: expire active holds whose authorization window elapsed.
 * Hold rows are retained as history; the status transition is atomic, so a
 * hold captured or released concurrently is not deleted or overwritten.
 * Run once a night from cron/the host's own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildDelete } from "./lib/sqlFilter.js";

/** Holds that outlived their authorization window without being captured
 *  or released — the candidate set for tonight's cleanup. */
export async function fetchExpiredHoldIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rows.map((r) => r.id);
}

export function buildExpiredHoldsDelete(expiredIds: string[]): { text: string; values: unknown[] } {
  return buildDelete("holds", { id: expiredIds });
}

/**
 * Marks only currently active, expired holds as expired. One conditional
 * UPDATE avoids a SELECT-then-DELETE race and leaves captured/released hold
 * history intact. The database update itself safely matches no rows when
 * nothing needs cleanup.
 */
export async function expireExpiredHolds(client: Client): Promise<number> {
  const result = await client.query(
    `UPDATE holds
        SET status = 'expired'
      WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expiredCount = await expireExpiredHolds(client);
    console.log(`expire_holds: marked ${expiredCount} expired hold(s)`);
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
