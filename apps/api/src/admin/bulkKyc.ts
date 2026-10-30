import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";
import type { Config } from "../config.js";
import { sendCompanyReviewNotices } from "../team/companyNotices.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  /** The admin's email, recorded as merchant_kyc_reviews.reviewer_identifier. */
  adminEmail: string;
  notes?: string;
  /** When given, each approved company's owner is emailed its company ID after
   *  the transaction commits. Best effort and in the background: it never
   *  delays, fails or rolls back the approval. */
  notice?: { config: Config; log: { warn: (obj: Record<string, unknown>, msg: string) => void } };
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 * @property skippedMerchantIds Requested ids that were not approved: unknown ids and
 * merchants not currently under_review (submitted, rejected, already approved).
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
  skippedMerchantIds: string[];
}

/**
 * Approves the given under_review merchants through the same review function
 * as the single-merchant path (one merchant_kyc_reviews row each) and audits it.
 */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  const result = await withTransaction(pool, async (client) => {
    // Lock the eligible rows so a concurrent review can't change their state
    // between this check and the approval.
    const eligible = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
        ORDER BY id
        FOR UPDATE`,
      [input.merchantIds],
    );
    const approvedMerchantIds = eligible.rows.map((row) => row.id);

    for (const merchantId of approvedMerchantIds) {
      await recordKycReviewInTx(client, {
        merchantId,
        outcome: "approved",
        reviewerIdentifier: input.adminEmail,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
    }

    const approved = new Set(approvedMerchantIds);
    const skippedMerchantIds = [...new Set(input.merchantIds.map((id) => id.toLowerCase()))].filter(
      (id) => !approved.has(id),
    );

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        skippedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds, skippedMerchantIds };
  });

  if (input.notice && result.approvedMerchantIds.length > 0) {
    // Not awaited: up to 200 emails must not hold the admin's response.
    void sendCompanyReviewNotices(pool, input.notice.config, input.notice.log, result.approvedMerchantIds, "approved", input.notes);
  }
  return result;
}
