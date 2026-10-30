import type { Pool, PoolClient } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { hashPassword } from "../adminAuth/passwords.js";
import type { AdminRole } from "../adminAuth/sessions.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { sendMail } from "../lib/mail.js";
import { adminInviteEmail } from "../lib/mailTemplates.js";

/**
 * Admin account management (master only; routes in routes/adminAccounts.ts).
 *
 * Invitation tokens are 32 random bytes (base64url). Only sha256(token) is
 * stored; the raw token exists in the emailed link and nowhere else. Every
 * state change runs in one transaction with its audit row. The invitation
 * email is sent inside the transaction, just before COMMIT: if delivery
 * fails the whole change (including the revocation of an older invitation)
 * rolls back, so no open invitation exists for a link nobody received.
 */

export const INVITE_TTL_HOURS = 48;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
/** Roles the master may hand out. `master` is deliberately absent. */
export const ASSIGNABLE_ROLES = ["support", "finance", "super_admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EmailDeliveryError extends AppError {
  constructor() {
    super(503, "email_delivery_unavailable", "The email could not be sent. Check the mail settings.");
  }
}

export interface AdminDto {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: "active" | "disabled";
  createdAt: string;
}

export interface AdminInviteDto {
  id: string;
  email: string;
  displayName: string;
  role: string;
  purpose: "invite" | "reset";
  expiresAt: string;
  createdAt: string;
  status: "open" | "expired";
}

interface InviteRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  purpose: "invite" | "reset";
  admin_user_id: string | null;
  expires_at: Date;
  created_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
}

const INVITE_COLUMNS = `id, email, display_name, role, purpose, admin_user_id, expires_at, created_at, redeemed_at, revoked_at`;

function toInviteDto(row: InviteRow): AdminInviteDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    purpose: row.purpose,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    status: row.expires_at.getTime() > Date.now() ? "open" : "expired",
  };
}

function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new NotFoundError(code);
}

export function parseAssignableRole(value: unknown): AssignableRole {
  if (typeof value !== "string" || !(ASSIGNABLE_ROLES as readonly string[]).includes(value)) {
    throw new BadRequestError("invalid_role", "role must be one of support, finance, super_admin");
  }
  return value as AssignableRole;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listAdminsAndInvites(pool: Pool): Promise<{ admins: AdminDto[]; invites: AdminInviteDto[] }> {
  const admins = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    role: AdminRole;
    status: "active" | "disabled";
    created_at: Date;
  }>(`SELECT id, email, display_name, role, status, created_at FROM admin_users ORDER BY created_at, email`);
  const invites = await pool.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM admin_account_invites
      WHERE redeemed_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  );
  return {
    admins: admins.rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    })),
    invites: invites.rows.map(toInviteDto),
  };
}

// ---------------------------------------------------------------------------
// Invitation creation, resend, revoke
// ---------------------------------------------------------------------------

function inviteLink(config: Config, token: string): string {
  const base = config.adminConsoleUrl ?? "http://localhost:5174";
  return `${base}/accept-invite?token=${token}`;
}

async function insertInviteAndMail(
  client: PoolClient,
  config: Config,
  input: {
    email: string;
    displayName: string;
    role: string;
    purpose: "invite" | "reset";
    adminUserId: string | null;
    createdBy: string;
  },
): Promise<InviteRow> {
  const token = randomToken(32);
  const result = await client.query<InviteRow>(
    `INSERT INTO admin_account_invites
       (email, display_name, role, purpose, admin_user_id, token_hash, created_by_admin_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))
     RETURNING ${INVITE_COLUMNS}`,
    [
      input.email,
      input.displayName,
      input.role,
      input.purpose,
      input.adminUserId,
      sha256Hex(token),
      input.createdBy,
      INVITE_TTL_HOURS,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("insert admin_account_invites returned no row");
  try {
    await sendMail(
      config,
      adminInviteEmail(input.email, {
        displayName: input.displayName,
        role: input.role,
        link: inviteLink(config, token),
        hours: INVITE_TTL_HOURS,
        purpose: input.purpose,
      }),
    );
  } catch {
    throw new EmailDeliveryError();
  }
  return row;
}

/** Records a failed delivery after the main transaction rolled back. Best effort. */
async function auditEmailFailure(
  pool: Pool,
  adminUserId: string,
  action: "admin_invite_created" | "admin_invite_resent" | "admin_reset_sent",
  targetType: "admin_invite" | "admin_user",
  targetId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await withTransaction(pool, (client) =>
      insertAdminAuditLog(client, {
        adminUserId,
        action,
        targetType,
        targetId,
        metadata: { ...metadata, error: "email_delivery_unavailable" },
        outcome: "failed",
      }),
    );
  } catch {
    /* the 503 is still returned to the caller */
  }
}

export function parseInviteBody(body: unknown): { email: string; displayName: string; role: AssignableRole } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new BadRequestError("invalid_email", "a valid email is required");
  }
  const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";
  if (!displayName || displayName.length > 100) {
    throw new BadRequestError("invalid_display_name", "displayName is required (at most 100 characters)");
  }
  return { email, displayName, role: parseAssignableRole(b.role) };
}

export async function createAdminInvite(
  deps: { pool: Pool; config: Config },
  actorId: string,
  input: { email: string; displayName: string; role: AssignableRole },
): Promise<AdminInviteDto> {
  try {
    const row = await withTransaction(deps.pool, async (client) => {
      const existing = await client.query(`SELECT 1 FROM admin_users WHERE lower(email) = $1`, [input.email]);
      if (existing.rows.length > 0) {
        throw new ConflictError("admin_exists", "An admin account with that email already exists.");
      }
      await client.query(
        `UPDATE admin_account_invites SET revoked_at = now()
          WHERE lower(email) = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
        [input.email],
      );
      const invite = await insertInviteAndMail(client, deps.config, {
        ...input,
        purpose: "invite",
        adminUserId: null,
        createdBy: actorId,
      });
      await insertAdminAuditLog(client, {
        adminUserId: actorId,
        action: "admin_invite_created",
        targetType: "admin_invite",
        targetId: invite.id,
        metadata: { email: input.email, role: input.role },
      });
      return invite;
    });
    return toInviteDto(row);
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      await auditEmailFailure(deps.pool, actorId, "admin_invite_created", "admin_invite", null, {
        email: input.email,
        role: input.role,
      });
    }
    throw err;
  }
}

export async function resendAdminInvite(
  deps: { pool: Pool; config: Config },
  actorId: string,
  inviteId: string,
): Promise<AdminInviteDto> {
  assertUuid(inviteId, "invite_not_found");
  try {
    const row = await withTransaction(deps.pool, async (client) => {
      const old = await client.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM admin_account_invites WHERE id = $1 FOR UPDATE`,
        [inviteId],
      );
      const prev = old.rows[0];
      if (!prev || prev.redeemed_at || prev.revoked_at) {
        throw new NotFoundError("invite_not_found");
      }
      await client.query(`UPDATE admin_account_invites SET revoked_at = now() WHERE id = $1`, [prev.id]);
      const invite = await insertInviteAndMail(client, deps.config, {
        email: prev.email,
        displayName: prev.display_name,
        role: prev.role,
        purpose: prev.purpose,
        adminUserId: prev.admin_user_id,
        createdBy: actorId,
      });
      await insertAdminAuditLog(client, {
        adminUserId: actorId,
        action: "admin_invite_resent",
        targetType: "admin_invite",
        targetId: invite.id,
        metadata: { email: prev.email, purpose: prev.purpose, replacedInviteId: prev.id },
      });
      return invite;
    });
    return toInviteDto(row);
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      await auditEmailFailure(deps.pool, actorId, "admin_invite_resent", "admin_invite", inviteId, {});
    }
    throw err;
  }
}

export async function revokeAdminInvite(pool: Pool, actorId: string, inviteId: string): Promise<void> {
  assertUuid(inviteId, "invite_not_found");
  await withTransaction(pool, async (client) => {
    const res = await client.query<{ email: string; purpose: string }>(
      `UPDATE admin_account_invites SET revoked_at = now()
        WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
        RETURNING email, purpose`,
      [inviteId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError("invite_not_found");
    await insertAdminAuditLog(client, {
      adminUserId: actorId,
      action: "admin_invite_revoked",
      targetType: "admin_invite",
      targetId: inviteId,
      metadata: { email: row.email, purpose: row.purpose },
    });
  });
}

// ---------------------------------------------------------------------------
// Redeeming an invitation (public)
// ---------------------------------------------------------------------------

const INVALID_INVITE_MESSAGE = "This invitation link is invalid or has expired.";

function invalidInvite(): BadRequestError {
  return new BadRequestError("invalid_invite", INVALID_INVITE_MESSAGE);
}

export async function revokeAllAdminSessions(client: PoolClient, adminUserId: string): Promise<void> {
  await client.query(
    `UPDATE admin_sessions SET revoked_at = now() WHERE admin_user_id = $1 AND revoked_at IS NULL`,
    [adminUserId],
  );
}

export async function acceptAdminInvite(
  deps: { pool: Pool; config: Config },
  body: unknown,
): Promise<{ email: string; purpose: "invite" | "reset" }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token : "";
  const password = typeof b.password === "string" ? b.password : "";
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      "weak_password",
      `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password.length > 256) {
    throw new BadRequestError("weak_password", "Password is too long.");
  }
  const requestedName = typeof b.displayName === "string" ? b.displayName.trim() : "";
  if (requestedName.length > 100) {
    throw new BadRequestError("invalid_display_name", "displayName must be at most 100 characters");
  }

  // The expensive hash is computed whether or not the token is valid, so a
  // bad token costs the caller about as long as a good one.
  const passwordHash = await hashPassword(password, deps.config);
  if (!token || token.length > 200) throw invalidInvite();
  const tokenHash = sha256Hex(token);

  return withTransaction(deps.pool, async (client) => {
    const found = await client.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM admin_account_invites WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const invite = found.rows[0];
    if (!invite || invite.redeemed_at || invite.revoked_at || invite.expires_at.getTime() <= Date.now()) {
      throw invalidInvite();
    }

    let adminUserId: string;
    if (invite.purpose === "invite") {
      const taken = await client.query(`SELECT 1 FROM admin_users WHERE lower(email) = lower($1)`, [invite.email]);
      if (taken.rows.length > 0) {
        throw new ConflictError("admin_exists", "An admin account with that email already exists.");
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, display_name, role, status)
         VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
        [invite.email, passwordHash, requestedName || invite.display_name, invite.role],
      );
      adminUserId = created.rows[0]!.id;
    } else {
      // Reset: only the password changes. The invite's role column is
      // ignored (the master's own reset carries a placeholder role).
      if (!invite.admin_user_id) throw invalidInvite();
      const updated = await client.query<{ id: string }>(
        `UPDATE admin_users SET password_hash = $2, password_updated_at = now() WHERE id = $1 RETURNING id`,
        [invite.admin_user_id, passwordHash],
      );
      if (!updated.rows[0]) throw invalidInvite();
      adminUserId = updated.rows[0].id;
      await revokeAllAdminSessions(client, adminUserId);
    }

    await client.query(`UPDATE admin_account_invites SET redeemed_at = now() WHERE id = $1`, [invite.id]);
    await insertAdminAuditLog(client, {
      adminUserId,
      action: "admin_invite_redeemed",
      targetType: "admin_invite",
      targetId: invite.id,
      metadata: { purpose: invite.purpose },
    });
    return { email: invite.email, purpose: invite.purpose };
  });
}

// ---------------------------------------------------------------------------
// Changing an existing admin, sending a reset
// ---------------------------------------------------------------------------

export function parseUpdateBody(body: unknown): { role?: AssignableRole; status?: "active" | "disabled" } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: { role?: AssignableRole; status?: "active" | "disabled" } = {};
  if (b.role !== undefined) out.role = parseAssignableRole(b.role);
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled") {
      throw new BadRequestError("invalid_status", "status must be active or disabled");
    }
    out.status = b.status;
  }
  if (out.role === undefined && out.status === undefined) {
    throw new BadRequestError("invalid_request", "role or status is required");
  }
  return out;
}

interface TargetRow {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: "active" | "disabled";
  created_at: Date;
}

async function lockTarget(client: PoolClient, actorId: string, targetId: string): Promise<TargetRow> {
  const res = await client.query<TargetRow>(
    `SELECT id, email, display_name, role, status, created_at FROM admin_users WHERE id = $1 FOR UPDATE`,
    [targetId],
  );
  const target = res.rows[0];
  if (!target) throw new NotFoundError("admin_not_found");
  if (target.role === "master") throw new ForbiddenError("cannot_modify_master");
  if (target.id === actorId) throw new ForbiddenError("cannot_modify_self");
  return target;
}

export async function updateAdmin(
  pool: Pool,
  actorId: string,
  targetId: string,
  change: { role?: AssignableRole; status?: "active" | "disabled" },
): Promise<AdminDto> {
  assertUuid(targetId, "admin_not_found");
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, actorId, targetId);
    const newRole = change.role ?? target.role;
    const newStatus = change.status ?? target.status;
    const updated = await client.query<TargetRow>(
      `UPDATE admin_users SET role = $2, status = $3 WHERE id = $1
       RETURNING id, email, display_name, role, status, created_at`,
      [target.id, newRole, newStatus],
    );
    if (newStatus === "disabled") {
      await revokeAllAdminSessions(client, target.id);
      await client.query(
        `UPDATE admin_impersonation_grants SET revoked_at = now()
          WHERE admin_user_id = $1 AND revoked_at IS NULL AND ended_at IS NULL`,
        [target.id],
      );
    }
    await insertAdminAuditLog(client, {
      adminUserId: actorId,
      action: "admin_updated",
      targetType: "admin_user",
      targetId: target.id,
      metadata: {
        email: target.email,
        before: { role: target.role, status: target.status },
        after: { role: newRole, status: newStatus },
      },
    });
    const r = updated.rows[0]!;
    return {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    };
  });
}

export async function sendAdminReset(
  deps: { pool: Pool; config: Config },
  actorId: string,
  targetId: string,
): Promise<AdminInviteDto> {
  assertUuid(targetId, "admin_not_found");
  try {
    const row = await withTransaction(deps.pool, async (client) => {
      const target = await lockTarget(client, actorId, targetId);
      await client.query(
        `UPDATE admin_account_invites SET revoked_at = now()
          WHERE lower(email) = lower($1) AND redeemed_at IS NULL AND revoked_at IS NULL`,
        [target.email],
      );
      const invite = await insertInviteAndMail(client, deps.config, {
        email: target.email,
        displayName: target.display_name,
        role: target.role,
        purpose: "reset",
        adminUserId: target.id,
        createdBy: actorId,
      });
      await insertAdminAuditLog(client, {
        adminUserId: actorId,
        action: "admin_reset_sent",
        targetType: "admin_user",
        targetId: target.id,
        metadata: { email: target.email, inviteId: invite.id },
      });
      return invite;
    });
    return toInviteDto(row);
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      await auditEmailFailure(deps.pool, actorId, "admin_reset_sent", "admin_user", targetId, {});
    }
    throw err;
  }
}
