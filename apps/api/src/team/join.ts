import type { Pool } from "pg";
import type { Config } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError } from "../lib/errors.js";
import { sendMailQuietly } from "../lib/mail.js";
import { joinRequestEmail } from "../lib/mailTemplates.js";
import { normalizeCompanyCode } from "./companyCode.js";

export const MAX_PENDING_PER_COMPANY = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CompanyJoinBody {
  companyCode?: unknown;
  fullName?: unknown;
  email?: unknown;
  password?: unknown;
  requestedRole?: unknown;
}

type Logger = { warn: (obj: Record<string, unknown>, msg: string) => void };

/**
 * A staff member asks to join an approved company by its ID. The account is
 * created as 'pending_owner_approval' and cannot sign in until the owner
 * approves it. Unknown, unapproved and suspended companies all give the same
 * 404 so the endpoint reveals nothing about which IDs exist.
 */
export async function requestToJoinCompany(
  pool: Pool,
  config: Config,
  log: Logger,
  body: CompanyJoinBody,
): Promise<void> {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const requestedRole = body.requestedRole === undefined || body.requestedRole === null ? "support" : body.requestedRole;

  if (typeof body.companyCode !== "string" || !body.companyCode.trim() || !fullName || !email || !password) {
    throw new BadRequestError("invalid_request", "companyCode, fullName, email and password are required");
  }
  if (requestedRole !== "finance" && requestedRole !== "support") {
    throw new BadRequestError("invalid_role", "requestedRole must be 'finance' or 'support'");
  }
  if (fullName.length > 120) throw new BadRequestError("invalid_request", "fullName is too long");
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new BadRequestError("invalid_email");
  if (password.length < 12) throw new BadRequestError("weak_password", "Use a password of at least 12 characters");
  if (password.length > 256) throw new BadRequestError("invalid_request", "password is too long");

  const code = normalizeCompanyCode(body.companyCode);
  if (!code) throw new NotFoundError("company_not_found");

  const passwordHash = await hashPassword(password, config);

  const outcome = await withTransaction(pool, async (client) => {
    // Lock the company row so concurrent requests cannot jump the pending cap.
    const company = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM merchants
        WHERE company_code = $1 AND onboarding_status = 'approved' AND status = 'active'
        FOR UPDATE`,
      [code],
    );
    const merchant = company.rows[0];
    if (!merchant) throw new NotFoundError("company_not_found");

    const existing = await client.query(
      `SELECT 1 FROM merchant_users WHERE merchant_id = $1 AND lower(email) = $2`,
      [merchant.id, email],
    );
    if (existing.rows.length > 0) {
      throw new ConflictError("already_requested", "This email already has an account or a pending request for this company");
    }

    const pending = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM merchant_users WHERE merchant_id = $1 AND status = 'pending_owner_approval'`,
      [merchant.id],
    );
    if (Number(pending.rows[0]!.n) >= MAX_PENDING_PER_COMPANY) {
      throw new TooManyRequestsError("too_many_pending", "This company has too many open requests. Ask the owner to review them.");
    }

    await client.query(
      `INSERT INTO merchant_users
         (merchant_id, email, role, password_hash, status, requested_role, full_name, status_changed_at)
       VALUES ($1, $2, $3, $4, 'pending_owner_approval', $3, $5, now())`,
      [merchant.id, email, requestedRole, passwordHash, fullName],
    );

    const owner = await client.query<{ email: string; full_name: string | null }>(
      `SELECT email, full_name FROM merchant_users
        WHERE merchant_id = $1 AND role = 'owner' AND status = 'active'
        ORDER BY created_at LIMIT 1`,
      [merchant.id],
    );
    return { companyName: merchant.display_name, owner: owner.rows[0] ?? null };
  });

  if (outcome.owner) {
    await sendMailQuietly(
      config,
      joinRequestEmail(outcome.owner.email, {
        ownerName: outcome.owner.full_name ?? outcome.companyName,
        companyName: outcome.companyName,
        staffName: fullName,
        staffEmail: email,
        role: requestedRole,
        teamUrl: `${config.dashboardUrl ?? ""}/dashboard/team`,
      }),
      log,
    );
  }
}
