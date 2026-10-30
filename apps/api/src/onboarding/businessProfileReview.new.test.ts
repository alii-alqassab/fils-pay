/** Changing the legal identity of an approved merchant sends it back to review. Requires DATABASE_URL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { recordKycReview } from "./review.js";
import { updateBusinessProfile } from "./businessProfile.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("businessProfileReview.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

async function approvedMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`BP ${randomUUID()}`]);
  const id = m.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_business_profiles (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Acme WLL', 'CR-1', 'llc', 'a@acme.test', '+97300000000', 'Road 1', 'Manama')`,
    [id],
  );
  await recordKycReview(pool, { merchantId: id, outcome: "approved", reviewerIdentifier: "test" });
  return id;
}

const status = async (id: string) =>
  (await pool.query<{ onboarding_status: string; kyc_passed: boolean }>(`SELECT onboarding_status, kyc_passed FROM merchants WHERE id = $1`, [id])).rows[0]!;

test("editing the phone number keeps an approved merchant approved", async () => {
  const id = await approvedMerchant();
  await updateBusinessProfile(pool, id, { contactPhone: "+97311111111" });
  assert.deepEqual(await status(id), { onboarding_status: "approved", kyc_passed: true });
});

test("changing the legal name or registration number sends it back to review", async () => {
  const id = await approvedMerchant();
  await updateBusinessProfile(pool, id, { legalName: "Other Trading WLL" });
  assert.deepEqual(await status(id), { onboarding_status: "under_review", kyc_passed: false });

  const id2 = await approvedMerchant();
  await updateBusinessProfile(pool, id2, { registrationNumber: "CR-2" });
  assert.equal((await status(id2)).onboarding_status, "under_review");
});

test("re-saving the same legal name does not trigger a re-review", async () => {
  const id = await approvedMerchant();
  await updateBusinessProfile(pool, id, { legalName: "Acme WLL" });
  assert.equal((await status(id)).onboarding_status, "approved");
});
