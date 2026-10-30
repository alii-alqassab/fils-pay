import type { FastifyInstance } from "fastify";
import { requestToJoinCompany, type CompanyJoinBody } from "../team/join.js";

/**
 * Registered with prefix '/v1/company-join'. PUBLIC (rate limited per IP in
 * lib/rateLimit.ts). Creates a staff account that waits for the owner.
 */
export async function companyJoinRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CompanyJoinBody }>("/", async (request, reply) => {
    await requestToJoinCompany(app.db, app.config, request.log, request.body ?? {});
    // Nothing else is returned: no ids, no company details.
    reply.code(201).send({ status: "pending_owner_approval" });
  });
}
