import type { FastifyInstance } from "fastify";
import { requireRole, requireSession } from "../auth/middleware.js";
import { UnauthorizedError } from "../lib/errors.js";
import { approveMember, listTeam, rejectMember, updateMember } from "../team/manage.js";

interface UserParams {
  userId: string;
}

/**
 * Registered with prefix '/v1/team'. Company owner only, and session only:
 * `requireSession` reads the session cookie and nothing else, so API keys and
 * impersonation grants never reach these routes. Every query is scoped by the
 * session's own merchantId, never by an id from the path or body.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [requireSession, requireRole("owner")] };
  const auth = (request: { auth?: { merchantId: string; merchantUserId: string } }) => {
    if (!request.auth) throw new UnauthorizedError("unauthenticated");
    return request.auth;
  };
  const ctx = () => ({
    config: app.config,
    log: app.log,
    loginUrl: `${app.config.dashboardUrl ?? ""}/dashboard/login`,
  });

  app.get("/", guard, async (request) => {
    const { merchantId } = auth(request);
    return { members: await listTeam(app.db, merchantId) };
  });

  app.post<{ Params: UserParams; Body: { role?: unknown } }>("/:userId/approve", guard, async (request) => {
    const { merchantId, merchantUserId } = auth(request);
    return approveMember(app.db, ctx(), {
      merchantId,
      ownerUserId: merchantUserId,
      userId: request.params.userId,
      role: request.body?.role,
    });
  });

  app.post<{ Params: UserParams }>("/:userId/reject", guard, async (request) => {
    const { merchantId } = auth(request);
    return rejectMember(app.db, ctx(), { merchantId, userId: request.params.userId });
  });

  app.patch<{ Params: UserParams; Body: { role?: unknown; status?: unknown } }>("/:userId", guard, async (request) => {
    const { merchantId, merchantUserId } = auth(request);
    return updateMember(app.db, {
      merchantId,
      actorUserId: merchantUserId,
      userId: request.params.userId,
      role: request.body?.role,
      status: request.body?.status,
    });
  });
}
