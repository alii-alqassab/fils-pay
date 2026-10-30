import type { FastifyInstance } from "fastify";
import {
  acceptAdminInvite,
  createAdminInvite,
  listAdminsAndInvites,
  parseInviteBody,
  parseUpdateBody,
  resendAdminInvite,
  revokeAdminInvite,
  sendAdminReset,
  updateAdmin,
} from "../admin/adminAccounts.js";
import { requireAdminSession, requireMaster } from "../adminAuth/middleware.js";
import { UnauthorizedError } from "../lib/errors.js";

interface IdParams {
  id: string;
}

/**
 * Admin account management. Registered with NO prefix under /v1/admin
 * (like adminCreditRoutes) because it spans /admins/* and the public
 * /auth/accept-invite.
 *
 * Everything under /admins is master-only: [requireAdminSession,
 * requireMaster]. accept-invite is public by design (the one-time token is
 * the credential) and is rate limited in lib/rateLimit.ts.
 */
export async function adminAccountRoutes(app: FastifyInstance): Promise<void> {
  const deps = { pool: app.db, config: app.config };

  app.post("/auth/accept-invite", async (request, reply) => {
    const result = await acceptAdminInvite(deps, request.body);
    // Deliberately no session: the person signs in normally (password + emailed OTP).
    reply.code(200).send({ ok: true, email: result.email, purpose: result.purpose });
  });

  app.register(async (scope) => {
    scope.addHook("preHandler", requireAdminSession);
    scope.addHook("preHandler", requireMaster);

    function actor(request: { adminAuth?: { adminUserId: string } }): string {
      if (!request.adminAuth) throw new UnauthorizedError("unauthenticated");
      return request.adminAuth.adminUserId;
    }

    scope.get("/admins", async () => listAdminsAndInvites(app.db));

    scope.post("/admins/invites", async (request, reply) => {
      const input = parseInviteBody(request.body);
      const invite = await createAdminInvite(deps, actor(request), input);
      reply.code(201).send({ invite });
    });

    scope.post<{ Params: IdParams }>("/admins/invites/:id/resend", async (request) => {
      const invite = await resendAdminInvite(deps, actor(request), request.params.id);
      return { invite };
    });

    scope.delete<{ Params: IdParams }>("/admins/invites/:id", async (request, reply) => {
      await revokeAdminInvite(app.db, actor(request), request.params.id);
      reply.code(204).send();
    });

    scope.patch<{ Params: IdParams }>("/admins/:id", async (request) => {
      const change = parseUpdateBody(request.body);
      const admin = await updateAdmin(app.db, actor(request), request.params.id, change);
      return { admin };
    });

    scope.post<{ Params: IdParams }>("/admins/:id/reset", async (request, reply) => {
      const invite = await sendAdminReset(deps, actor(request), request.params.id);
      reply.code(201).send({ invite });
    });
  });
}
