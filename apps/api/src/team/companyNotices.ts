import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { sendMailQuietly } from "../lib/mail.js";
import { companyApprovedEmail, companyRejectedEmail } from "../lib/mailTemplates.js";

type Logger = { warn: (obj: Record<string, unknown>, msg: string) => void };

interface NoticeRow {
  display_name: string;
  company_code: string | null;
  owner_email: string | null;
  owner_name: string | null;
}

/**
 * Tells each company's owner the outcome of the admin review (approved with the
 * company ID, or rejected with the reviewer's note). Call AFTER the review's
 * transaction has committed. Never throws: an email problem must not fail or
 * undo a review, it is only logged.
 */
export async function sendCompanyReviewNotices(
  db: Pool | PoolClient,
  config: Config,
  log: Logger,
  merchantIds: string[],
  outcome: "approved" | "rejected",
  notes?: string | null,
): Promise<void> {
  try {
    if (merchantIds.length === 0) return;
    const result = await db.query<NoticeRow>(
      `SELECT m.display_name, m.company_code, o.email AS owner_email, o.full_name AS owner_name
         FROM merchants m
         LEFT JOIN LATERAL (
           SELECT email, full_name FROM merchant_users
            WHERE merchant_id = m.id AND role = 'owner'
            ORDER BY created_at LIMIT 1
         ) o ON true
        WHERE m.id = ANY($1::uuid[])`,
      [merchantIds],
    );
    for (const row of result.rows) {
      if (!row.owner_email) continue;
      if (outcome === "approved") {
        if (!row.company_code) continue;
        await sendMailQuietly(
          config,
          companyApprovedEmail(row.owner_email, {
            ownerName: row.owner_name ?? row.display_name,
            companyName: row.display_name,
            companyCode: row.company_code,
            dashboardUrl: config.dashboardUrl ?? "",
          }),
          log,
        );
      } else {
        await sendMailQuietly(
          config,
          companyRejectedEmail(row.owner_email, { companyName: row.display_name, notes }),
          log,
        );
      }
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "company review notice failed");
  }
}
