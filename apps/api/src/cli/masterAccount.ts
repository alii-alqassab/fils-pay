import type { Pool } from "pg";
import type { Config } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { sendMail } from "../lib/mail.js";
import { adminInviteEmail } from "../lib/mailTemplates.js";

/**
 * The single "master" admin account: created and recovered ONLY from the
 * server (npm run master:create / master:reset), never through an API.
 * The master is the only account allowed to create other admins.
 */
export const MIN_PASSWORD_LENGTH = 12;
const SETUP_LINK_HOURS = 48;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MasterInput {
  email: string;
  displayName?: string;
  /** Set the password directly. */
  password?: string;
  /** Instead of a password, email a one-time "choose your password" link. */
  sendSetupEmail?: boolean;
}

export interface MasterResult {
  adminUserId: string;
  email: string;
  setupEmailSent: boolean;
}

function assertInput(input: MasterInput): { email: string; displayName: string } {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new Error("A valid --email is required.");
  }
  if (!input.password && !input.sendSetupEmail) {
    throw new Error("Give a password (hidden prompt or MASTER_PASSWORD) or use --setup-email.");
  }
  if (input.password && input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return { email, displayName: (input.displayName ?? "Master").trim() || "Master" };
}

/** Creates a one-time password-setup invitation for an existing admin and
 *  emails the link. Returns false (without throwing) if the email fails, so
 *  the caller can tell the operator to retry; the invitation is then removed. */
async function emailSetupLink(
  pool: Pool,
  config: Config,
  admin: { id: string; email: string; displayName: string },
): Promise<boolean> {
  const token = randomToken(32);
  const inviteId = await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE admin_account_invites SET revoked_at = now()
        WHERE lower(email) = lower($1) AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [admin.email],
    );
    const inserted = await client.query<{ id: string }>(
      // role holds a placeholder: the table does not allow 'master', and a
      // 'reset' invitation only ever changes the password, never the role.
      `INSERT INTO admin_account_invites
         (email, display_name, role, purpose, admin_user_id, token_hash, created_by_admin_user_id, expires_at)
       VALUES ($1, $2, 'super_admin', 'reset', $3, $4, $3, now() + ($5 || ' hours')::interval)
       RETURNING id`,
      [admin.email, admin.displayName, admin.id, sha256Hex(token), String(SETUP_LINK_HOURS)],
    );
    return inserted.rows[0]!.id;
  });
  try {
    await sendMail(
      config,
      adminInviteEmail(admin.email, {
        displayName: admin.displayName,
        role: "master",
        link: `${config.adminConsoleUrl ?? "http://localhost:5174"}/accept-invite?token=${token}`,
        hours: SETUP_LINK_HOURS,
        purpose: "reset",
      }),
    );
    return true;
  } catch (err) {
    await pool.query(`DELETE FROM admin_account_invites WHERE id = $1`, [inviteId]);
    console.error(`Could not send the setup email: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Creates THE master account. Refuses if one already exists. */
export async function createMaster(pool: Pool, config: Config, input: MasterInput): Promise<MasterResult> {
  const { email, displayName } = assertInput(input);
  // With --setup-email the stored password is random and never shown: the
  // owner chooses the real one through the emailed link.
  const passwordHash = await hashPassword(input.password ?? randomToken(48), config);

  const adminUserId = await withTransaction(pool, async (client) => {
    const existing = await client.query<{ email: string }>(`SELECT email FROM admin_users WHERE role = 'master'`);
    if (existing.rows[0]) {
      throw new Error(
        `A master account already exists (${existing.rows[0].email}). There can only be one. ` +
          `Use "npm run master:reset" if the password was lost.`,
      );
    }
    const taken = await client.query(`SELECT 1 FROM admin_users WHERE lower(email) = $1`, [email]);
    if (taken.rows[0]) {
      throw new Error(`An admin with the email ${email} already exists.`);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO admin_users (email, password_hash, display_name, role, status)
       VALUES ($1, $2, $3, 'master', 'active') RETURNING id`,
      [email, passwordHash, displayName],
    );
    const id = inserted.rows[0]!.id;
    await insertAdminAuditLog(client, {
      adminUserId: id,
      action: "master_created",
      targetType: "admin_user",
      targetId: id,
      metadata: { via: input.sendSetupEmail ? "setup_email" : "password" },
    });
    return id;
  });

  const setupEmailSent = input.sendSetupEmail
    ? await emailSetupLink(pool, config, { id: adminUserId, email, displayName })
    : false;
  return { adminUserId, email, setupEmailSent };
}

/** Recovers the master: sets a new password directly or emails a setup link.
 *  Existing master sessions are revoked either way. */
export async function resetMaster(pool: Pool, config: Config, input: Omit<MasterInput, "email"> & { email?: string }): Promise<MasterResult> {
  if (!input.password && !input.sendSetupEmail) {
    throw new Error("Give a new password (hidden prompt or MASTER_PASSWORD) or use --setup-email.");
  }
  if (input.password && input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const master = await pool.query<{ id: string; email: string; display_name: string }>(
    `SELECT id, email, display_name FROM admin_users WHERE role = 'master'`,
  );
  const row = master.rows[0];
  if (!row) {
    throw new Error('There is no master account yet. Run "npm run master:create -- --email you@example.com".');
  }
  if (input.email && input.email.trim().toLowerCase() !== row.email.toLowerCase()) {
    throw new Error("That email is not the master account's email.");
  }

  await withTransaction(pool, async (client) => {
    if (input.password) {
      await client.query(
        `UPDATE admin_users SET password_hash = $2, password_updated_at = now() WHERE id = $1`,
        [row.id, await hashPassword(input.password, config)],
      );
    }
    await client.query(`UPDATE admin_sessions SET revoked_at = now() WHERE admin_user_id = $1 AND revoked_at IS NULL`, [row.id]);
    await insertAdminAuditLog(client, {
      adminUserId: row.id,
      action: "master_password_reset",
      targetType: "admin_user",
      targetId: row.id,
      metadata: { via: input.sendSetupEmail ? "setup_email" : "password" },
    });
  });

  const setupEmailSent = input.sendSetupEmail
    ? await emailSetupLink(pool, config, { id: row.id, email: row.email, displayName: row.display_name })
    : false;
  return { adminUserId: row.id, email: row.email, setupEmailSent };
}
