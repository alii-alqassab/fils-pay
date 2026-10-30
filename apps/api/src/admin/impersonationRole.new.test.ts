/**
 * DISC-S-7: every admin role impersonates as merchant `support` (view-only).
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { lookupImpersonationGrant, startImpersonation } from "./impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("impersonationRole.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

for (const role of ["support", "finance", "super_admin"] as const) {
  test(`${role} admin grant resolves to merchantRole 'support' and is 403 on owner/finance webhook routes`, async () => {
    const suffix = randomUUID();
    const merchant = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`Imp ${suffix.slice(0, 8)}`],
    );
    const merchantId = merchant.rows[0]!.id;
    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, password_hash, display_name, role)
       VALUES ($1, 'x', $2, $3) RETURNING id`,
      [`imp-${suffix}@imp.test`, `Imp ${role}`, role],
    );
    const started = await startImpersonation(pool, {
      adminUserId: admin.rows[0]!.id,
      merchantId,
      ttlMinutes: 5,
    });

    const grant = await lookupImpersonationGrant(pool, started.rawToken);
    assert.ok(grant);
    assert.equal(grant.merchantRole, "support");

    const res = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      cookies: { [config.impersonationCookieName]: started.rawToken },
    });
    assert.equal(res.statusCode, 403, res.body);
  });
}
