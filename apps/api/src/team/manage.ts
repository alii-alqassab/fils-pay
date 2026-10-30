import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { sendMailQuietly } from "../lib/mail.js";
import { joinDecisionEmail } from "../lib/mailTemplates.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StaffRole = "finance" | "support";
type Logger = { warn: (obj: Record<string, unknown>, msg: string) => void };

export interface TeamMember {
  id: string;
  email: string;
  fullName: string | null;
  role: "owner" | "finance" | "support";
  status: "active" | "pending_owner_approval" | "rejected" | "disabled";
  requestedRole: StaffRole | null;
  createdAt: string;
  approvedAt: string | null;
}

interface MemberRow {
  id: string;
  email: string;
  full_name: string | null;
  role: TeamMember["role"];
  status: TeamMember["status"];
  requested_role: StaffRole | null;
  created_at: Date;
  approved_at: Date | null;
}

function toMember(row: MemberRow): TeamMember {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    requestedRole: row.requested_role,
    createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
  };
}

const MEMBER_COLUMNS = `id, email, full_name, role, status, requested_role, created_at, approved_at`;

function parseStaffRole(value: unknown): StaffRole | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "finance" || value === "support") return value;
  throw new BadRequestError("invalid_role", "role must be 'finance' or 'support'");
}

export async function listTeam(pool: Pool, merchantId: string): Promise<TeamMember[]> {
  const result = await pool.query<MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM merchant_users
      WHERE merchant_id = $1
      ORDER BY (role = 'owner') DESC, created_at, id`,
    [merchantId],
  );
  return result.rows.map(toMember);
}

/** Locks one member of THIS company. A user id from another company is just "not found". */
async function lockMember(client: PoolClient, merchantId: string, userId: string): Promise<MemberRow & { company_name: string }> {
  if (!UUID_RE.test(userId)) throw new NotFoundError("team_member_not_found");
  const result = await client.query<MemberRow & { company_name: string }>(
    `SELECT mu.id, mu.email, mu.full_name, mu.role, mu.status, mu.requested_role, mu.created_at, mu.approved_at,
            m.display_name AS company_name
       FROM merchant_users mu JOIN merchants m ON m.id = mu.merchant_id
      WHERE mu.id = $1 AND mu.merchant_id = $2
      FOR UPDATE OF mu`,
    [userId, merchantId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("team_member_not_found");
  return row;
}

/** Ends every session of one person and their pending sign-in codes, immediately. */
async function cutOffAccess(client: PoolClient, userId: string): Promise<void> {
  await client.query(`UPDATE sessions SET revoked_at = now() WHERE merchant_user_id = $1 AND revoked_at IS NULL`, [userId]);
  await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE merchant_user_id = $1 AND consumed_at IS NULL`, [userId]);
}

export interface DecisionContext {
  config: Config;
  log: Logger;
  loginUrl: string;
}

async function notifyDecision(
  ctx: DecisionContext,
  member: { email: string; full_name: string | null; company_name: string },
  approved: boolean,
  role?: string,
): Promise<void> {
  await sendMailQuietly(
    ctx.config,
    joinDecisionEmail(member.email, {
      staffName: member.full_name ?? member.email,
      companyName: member.company_name,
      approved,
      role,
      loginUrl: ctx.loginUrl,
    }),
    ctx.log,
  );
}

export async function approveMember(
  pool: Pool,
  ctx: DecisionContext,
  input: { merchantId: string; ownerUserId: string; userId: string; role?: unknown },
): Promise<TeamMember> {
  const chosenRole = parseStaffRole(input.role);
  const { member, row } = await withTransaction(pool, async (client) => {
    const current = await lockMember(client, input.merchantId, input.userId);
    if (current.status !== "pending_owner_approval") {
      throw new ConflictError("not_pending", "Only requests that are waiting for approval can be approved");
    }
    const role = chosenRole ?? current.requested_role ?? "support";
    const updated = await client.query<MemberRow>(
      `UPDATE merchant_users
          SET status = 'active', role = $3, approved_by_user_id = $4, approved_at = now(), status_changed_at = now()
        WHERE id = $1 AND merchant_id = $2
        RETURNING ${MEMBER_COLUMNS}`,
      [input.userId, input.merchantId, role, input.ownerUserId],
    );
    return { member: toMember(updated.rows[0]!), row: current };
  });
  await notifyDecision(ctx, row, true, member.role);
  return member;
}

export async function rejectMember(
  pool: Pool,
  ctx: DecisionContext,
  input: { merchantId: string; userId: string },
): Promise<TeamMember> {
  const { member, row } = await withTransaction(pool, async (client) => {
    const current = await lockMember(client, input.merchantId, input.userId);
    if (current.status !== "pending_owner_approval") {
      throw new ConflictError("not_pending", "Only requests that are waiting for approval can be rejected");
    }
    const updated = await client.query<MemberRow>(
      `UPDATE merchant_users SET status = 'rejected', status_changed_at = now()
        WHERE id = $1 AND merchant_id = $2 RETURNING ${MEMBER_COLUMNS}`,
      [input.userId, input.merchantId],
    );
    await cutOffAccess(client, input.userId);
    return { member: toMember(updated.rows[0]!), row: current };
  });
  await notifyDecision(ctx, row, false);
  return member;
}

export async function updateMember(
  pool: Pool,
  input: { merchantId: string; actorUserId: string; userId: string; role?: unknown; status?: unknown },
): Promise<TeamMember> {
  const role = parseStaffRole(input.role);
  const status = input.status;
  if (status !== undefined && status !== "active" && status !== "disabled") {
    throw new BadRequestError("invalid_status", "status must be 'active' or 'disabled'");
  }
  if (role === undefined && status === undefined) {
    throw new BadRequestError("invalid_request", "role or status is required");
  }

  return withTransaction(pool, async (client) => {
    const current = await lockMember(client, input.merchantId, input.userId);
    if (current.id === input.actorUserId) {
      throw new ForbiddenError("cannot_change_self");
    }
    if (current.role === "owner") {
      throw new ForbiddenError("cannot_change_owner");
    }
    // Members who already joined can be changed; pending and rejected people go through approve/reject.
    if (current.status !== "active" && current.status !== "disabled") {
      throw new ConflictError("not_a_member", "Approve the request first");
    }
    if (current.status === "disabled" && status !== "active") {
      throw new ConflictError("member_disabled", "Enable this person before changing the role");
    }

    const updated = await client.query<MemberRow>(
      `UPDATE merchant_users
          SET role = COALESCE($3, role),
              status = COALESCE($4::text, status),
              status_changed_at = CASE WHEN $4::text IS NOT NULL AND $4::text <> status THEN now() ELSE status_changed_at END
        WHERE id = $1 AND merchant_id = $2
        RETURNING ${MEMBER_COLUMNS}`,
      [input.userId, input.merchantId, role ?? null, status ?? null],
    );
    // A role change needs no extra step: the role is read on every request.
    if (status === "disabled") {
      await cutOffAccess(client, input.userId);
    }
    return toMember(updated.rows[0]!);
  });
}
