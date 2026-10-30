import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { assertDistinctApprover } from "./creditApproval.js";
import { approveCreditRequest, createCreditRequest } from "./credits.js";
import { AppError } from "../lib/errors.js";

test("same admin id is rejected even when display names differ (rename / second label)", () => {
  const id = randomUUID();
  assert.throws(
    () => assertDistinctApprover({ adminUserId: id, displayName: "Dana F." }, { adminUserId: id, displayName: "Dana Finance" }),
    (e: unknown) => e instanceof AppError && e.code === "self_approval_forbidden" && e.statusCode === 409,
  );
});

test("different admin ids with identical display names are allowed", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Sam Ahmed" },
      { adminUserId: randomUUID(), displayName: "Sam Ahmed" },
    ),
  );
});

const databaseUrl = process.env.DATABASE_URL;

test("db: requester cannot approve via renamed account; same-name distinct admin can; threshold is principal only", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const mk = async (label: string, name: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', $2, 'finance') RETURNING id`,
        [`${label}-${randomUUID()}@admin.test`, name],
      )).rows[0]!.id;
    const merchantId = (await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`adm1 ${randomUUID()}`],
    )).rows[0]!.id;
    const name = `Twin ${randomUUID().slice(0, 8)}`;
    const maker = await mk("maker", name);
    const other = await mk("other", name); // same display name, different person
    const today = new Date().toISOString().slice(0, 10);

    const pending = await createCreditRequest(pool, {
      merchantId, adminUserId: maker,
      body: { baseAmountFils: 90_000, reasonCode: "goodwill", effectiveDate: today },
    });
    assert.equal(pending.status, "pending_approval");

    // renamed requester approving own request
    await pool.query(`UPDATE admin_users SET display_name = 'Renamed' WHERE id = $1`, [maker]);
    await assert.rejects(
      approveCreditRequest(pool, { creditRequestId: pending.id, approver: { adminUserId: maker, displayName: "Renamed" } }),
      (e: unknown) => e instanceof AppError && e.code === "self_approval_forbidden",
    );
    const ok = await approveCreditRequest(pool, {
      creditRequestId: pending.id, approver: { adminUserId: other, displayName: name },
    });
    assert.equal(ok.status, "posted");
    await assert.rejects(
      approveCreditRequest(pool, { creditRequestId: pending.id, approver: { adminUserId: other, displayName: name } }),
      (e: unknown) => e instanceof AppError && e.code === "credit_request_not_pending",
    );

    // exactly 50.000 BD principal + fee reversal posts without approval (principal only)
    const edge = await createCreditRequest(pool, {
      merchantId, adminUserId: maker,
      body: { baseAmountFils: 50_000, reasonCode: "goodwill", effectiveDate: today, reverseFee: true },
    });
    assert.equal(edge.status, "posted");
  } finally {
    await pool.end();
  }
});
