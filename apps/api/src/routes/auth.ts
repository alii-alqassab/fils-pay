import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../auth/passwords.js";
import { issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  rotateSessionToken,
  revokeSession,
} from "../auth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { AppError, BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  merchantId?: string;
  registrationNumber?: string;
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
  display_name?: string;
  status?: "active" | "pending_owner_approval" | "rejected" | "disabled";
}

/**
 * Merchant login is two-step: the legacy POST /login accepts merchantId,
 * while POST /email-login resolves the merchant from email and password.
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const handleLogin = async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const { merchantId, registrationNumber, email, password } = request.body ?? {};
    if (!email?.trim() || !password) {
      throw new BadRequestError("invalid_request", "email and password are required");
    }

    const userResult = merchantId
      ? await app.db.query<MerchantUserRow>(
        `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash, mu.status
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
        [merchantId, email.trim()],
      )
      : await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash, mu.status, m.display_name
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
         LEFT JOIN merchant_business_profiles bp ON bp.merchant_id = m.id
        WHERE lower(mu.email) = lower($1) AND m.status = 'active'
          AND ($2::uuid IS NULL OR mu.merchant_id = $2)
          AND ($3::text IS NULL OR bp.registration_number = $3)
        ORDER BY mu.merchant_id
        LIMIT $4`,
      // S-17: cap argon2 verifies per request (each is ~tens of ms of CPU).
      [email.trim(), merchantId || null, registrationNumber?.trim() || null, app.config.loginMaxCandidates ?? 5],
    );
    const matches: MerchantUserRow[] = [];
    for (const candidate of userResult.rows) {
      if (await verifyPassword(candidate.password_hash, password)) matches.push(candidate);
    }
    if (userResult.rows.length === 0) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
    }

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (matches.length === 0) {
      throw new UnauthorizedError("invalid_credentials");
    }

    // Staff who asked to join a company stay blocked until the owner approves
    // them; rejected or disabled people are blocked for good. This is only
    // said AFTER the password was correct, so it does not reveal which emails
    // exist. If someone with this password has several accounts, only the
    // usable ones count.
    const usable = matches.filter((match) => (match.status ?? "active") === "active");
    if (usable.length === 0) {
      const blocked = matches[0]!;
      if (blocked.status === "pending_owner_approval") {
        throw new AppError(
          403,
          "account_pending_owner_approval",
          "Your request is waiting for the company owner to approve it. You can sign in after that.",
        );
      }
      throw new AppError(403, "account_disabled", "This account cannot sign in. Please contact your company owner.");
    }
    if (usable.length > 1) {
      return reply.code(409).send({
        error: "merchant_selection_required",
        message: "Choose the business you want to sign in to.",
        merchants: usable.map((match) => ({ id: match.merchant_id, displayName: match.display_name })),
      });
    }

    // The recipient must be the exact merchant user whose password passed.
    // Email alone is not an identity: it can belong to users in other merchants.
    const recipient = usable[0]!;

    const { code, expiresAt, rawToken, sessionId } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken, sessionId: session.id };
    });

    try {
      await sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);
    } catch (err) {
      await revokeSession(app.db, sessionId);
      request.log.error({ err }, "merchant otp delivery failed");
      throw new AppError(503, "otp_delivery_unavailable", "Could not send the sign-in code. Please try again.");
    }

    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  };

  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    if (!request.body?.merchantId || !request.body.email || !request.body.password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }
    return handleLogin(request, reply);
  });
  app.post<{ Body: LoginBody }>("/email-login", handleLogin);

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }

      const verification = await withTransaction(app.db, async (client) => {
        // Lock the session before its challenge, matching the resend path. A
        // lookup performed before waiting for this lock is not authorization
        // to verify a session that was promoted, revoked, or given a new code.
        const sessionResult = await client.query<{ expires_at: Date }>(
          `SELECT expires_at FROM sessions
            WHERE id = $1 AND merchant_user_id = $2 AND otp_challenge_id = $3
              AND authenticated = false AND revoked_at IS NULL
            FOR UPDATE`,
          [pending.sessionId, pending.merchantUserId, pending.otpChallengeId],
        );
        const session = sessionResult.rows[0];
        if (!session || session.expires_at.getTime() <= Date.now()) {
          return { error: new UnauthorizedError("no_pending_session") };
        }

        const challengeResult = await client.query<{
          id: string;
          code_salt: string;
          code_hash: string;
          attempt_count: number;
          max_attempts: number;
          expires_at: Date;
          consumed_at: Date | null;
        }>(
          `SELECT id, code_salt, code_hash, attempt_count, max_attempts, expires_at, consumed_at
             FROM otp_challenges WHERE id = $1 AND merchant_user_id = $2 FOR UPDATE`,
          [pending.otpChallengeId, pending.merchantUserId],
        );
        const challenge = challengeResult.rows[0];
        if (!challenge || challenge.consumed_at !== null || challenge.expires_at.getTime() <= Date.now()) {
          return { error: new GoneError("otp_expired") };
        }
        if (challenge.attempt_count >= challenge.max_attempts) {
          await revokeSession(client, pending.sessionId);
          return { error: new TooManyRequestsError("too_many_attempts") };
        }
        if (!verifyOtpCode(code, challenge.code_salt, challenge.code_hash)) {
          await client.query(`UPDATE otp_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`, [
            challenge.id,
          ]);
          // Return expected errors so the failed guess commits before the
          // HTTP handler throws; throwing here would refund the guess budget.
          return { error: new UnauthorizedError("invalid_code") };
        }

        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
        // promoteSession bumps expires_at to 12h server-side; the cookie maxAge doesn't matter because
        // MK: admin verify re-sets the cookie after this, merchant verify doesnt. related to the 10 min logouts?
        await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        // Rotating the token at the OTP step stops a pending token that leaked before
        // verification from becoming the authenticated one. Default: on in production,
        // off elsewhere (ROTATE_SESSION_ON_OTP_VERIFY): locked route tests reuse the pre-verify cookie.
        const newToken = app.config.rotateSessionOnOtpVerify
          ? await rotateSessionToken(client, pending.sessionId)
          : null;
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        const user = result.rows[0];
        if (!user) {
          throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
        }
        return { user, newToken };
      });
      if (verification.error) throw verification.error;
      const merchantUserResult = verification.user;
      const newToken = verification.newToken ?? request.cookies[app.config.cookieName] ?? "";

      // Match the browser cookie lifetime to the promoted server-side
      // session; otherwise the browser still drops it at the pending TTL.
      reply.setCookie(app.config.cookieName, newToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: app.config.sessionTtlHours * 3_600,
      });

      reply.code(200).send({
        authenticated: true,
        merchantId: merchantUserResult.merchant_id,
        role: merchantUserResult.role,
      });
    },
  );

  /**
   * Re-issues the OTP for a pending session. Throttled to one per 30s. The
   * new challenge inherits the previous challenge's attempt_count so a
   * resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[app.config.cookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    const resendResult = await withTransaction(app.db, async (client) => {
      // Lock the pending session first so concurrent resends cannot both
      // replace the challenge based on the same stale lookup.
      const sessionResult = await client.query<{ otp_challenge_id: string | null }>(
        `SELECT otp_challenge_id FROM sessions
          WHERE id = $1 AND merchant_user_id = $2
            AND authenticated = false AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [pending.sessionId, pending.merchantUserId],
      );
      const session = sessionResult.rows[0];
      if (!session || session.otp_challenge_id !== pending.otpChallengeId) {
        throw new GoneError("otp_expired");
      }

      const existingResult = await client.query<{
        id: string;
        created_at: Date;
        attempt_count: number;
        max_attempts: number;
        consumed_at: Date | null;
      }>(
        `SELECT id, created_at, attempt_count, max_attempts, consumed_at
           FROM otp_challenges WHERE id = $1 AND merchant_user_id = $2 FOR UPDATE`,
        [pending.otpChallengeId, pending.merchantUserId],
      );
      const existingChallenge = existingResult.rows[0];
      if (!existingChallenge || existingChallenge.consumed_at !== null) {
        throw new GoneError("otp_expired");
      }
      if (Date.now() - existingChallenge.created_at.getTime() < 30_000) {
        throw new TooManyRequestsError("resend_too_soon");
      }
      if (existingChallenge.attempt_count >= existingChallenge.max_attempts) {
        await client.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [pending.sessionId]);
        return { exhausted: true as const };
      }

      await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [
        existingChallenge.id,
      ]);
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      // Resending changes the code, not the guess budget. Carry forward
      // failed attempts so repeated resends cannot grant fresh guesses.
      await client.query(`UPDATE otp_challenges SET attempt_count = $2 WHERE id = $1`, [
        challenge.id,
        existingChallenge.attempt_count,
      ]);
      await client.query(`UPDATE sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.sessionId,
      ]);
      return challenge;
    });
    if ("exhausted" in resendResult) {
      throw new TooManyRequestsError("too_many_attempts");
    }
    const { code, expiresAt } = resendResult;

    const userResult = await app.db.query<{ email: string }>(
      `SELECT email FROM merchant_users WHERE id = $1`,
      [pending.merchantUserId],
    );
    try {
      await sendOtpCode(
        request.log,
        app.config,
        { merchantUserId: pending.merchantUserId, email: userResult.rows[0]?.email ?? "" },
        code,
      );
    } catch (err) {
      await revokeSession(app.db, pending.sessionId);
      request.log.error({ err }, "merchant otp resend delivery failed");
      throw new AppError(503, "otp_delivery_unavailable", "Could not send the sign-in code. Please sign in again.");
    }

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.get(
    "/me",
    { preHandler: requireSession },
    async (request: FastifyRequest) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      const result = await app.db.query<{
        email: string;
        full_name: string | null;
        status: string;
        merchant_id: string;
        display_name: string;
        onboarding_status: string;
        company_code: string | null;
      }>(
        `SELECT mu.email, mu.full_name, mu.status, m.id AS merchant_id, m.display_name, m.onboarding_status,
                m.company_code
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.id = $1`,
        [auth.merchantUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedError("unauthenticated");
      }
      return {
        merchantUserId: auth.merchantUserId,
        email: row.email,
        fullName: row.full_name,
        status: row.status,
        role: auth.role,
        // The company ID is shown to the owner only, and only once the company is approved.
        ...(auth.role === "owner" && row.onboarding_status === "approved" && row.company_code
          ? { companyCode: row.company_code }
          : {}),
        merchant: {
          id: row.merchant_id,
          displayName: row.display_name,
          onboardingStatus: row.onboarding_status,
        },
      };
    },
  );

  app.post(
    "/logout",
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeSession(app.db, auth.sessionId);
      reply.setCookie(app.config.cookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}
