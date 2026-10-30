import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireRole, requireSession } from "../auth/middleware.js";
import { createMerchantWithOwner, type SignupInput } from "../onboarding/signup.js";
import { getBusinessProfile, updateBusinessProfile, type BusinessProfilePatch } from "../onboarding/businessProfile.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

interface MerchantIdParams {
  merchantId: string;
}

/**
 * Registered with prefix '/v1/merchants'. Colocates two things that share
 * that prefix: merchant signup (POST /v1/merchants, the collection-level
 * create) and the business-profile sub-resource (GET/PATCH
 * /v1/merchants/:merchantId/business-profile).
 */
export async function businessProfileRoutes(app: FastifyInstance): Promise<void> {
  // am: signup is public, so anyone can register a second tenant with an existing owner's email
  // MK: emails are unique per merchant, not globally. that's by design
  app.post<{ Body: Partial<SignupInput> }>("/", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.businessProfile || !body.owner) {
      throw new BadRequestError("invalid_request", "businessProfile and owner are required");
    }
    const bp = body.businessProfile;
    const owner = body.owner;
    const required = [bp.legalName, bp.registrationNumber, bp.contactEmail, bp.contactPhone,
      bp.addressLine1, bp.city, owner.email, owner.password];
    if (required.some((value) => typeof value !== "string" || !value.trim())) {
      throw new BadRequestError("invalid_request", "missing required business profile or owner fields");
    }
    if (!["sole_proprietorship", "llc", "partnership", "public_company", "other"].includes(bp.businessType ?? "")) {
      throw new BadRequestError("invalid_business_type");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bp.contactEmail)) {
      throw new BadRequestError("invalid_email");
    }
    if (owner.password.length < 12) {
      throw new BadRequestError("weak_password", "Use a password of at least 12 characters");
    }
    if (bp.country !== undefined && (typeof bp.country !== "string" || !/^[A-Z]{2}$/.test(bp.country))) {
      throw new BadRequestError("invalid_country");
    }

    const result = await createMerchantWithOwner(app.db, app.config, {
      businessProfile: {
        ...bp,
        legalName: bp.legalName.trim(),
        registrationNumber: bp.registrationNumber.trim(),
        contactEmail: bp.contactEmail.trim().toLowerCase(),
        contactPhone: bp.contactPhone.trim(),
        addressLine1: bp.addressLine1.trim(),
        city: bp.city.trim(),
      },
      owner: { email: owner.email.trim().toLowerCase(), password: owner.password },
    } as SignupInput);
    reply.code(201).send({
      merchantId: result.merchantId,
      ownerUserId: result.ownerUserId,
      onboardingStatus: result.onboardingStatus,
    });
  });

  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/business-profile",
    { preHandler: requireSession },
    async (request) => {
      assertOwnMerchant(request);
      const profile = await getBusinessProfile(app.db, request.params.merchantId);
      return profile;
    },
  );

  app.patch<{ Params: MerchantIdParams; Body: BusinessProfilePatch }>(
    "/:merchantId/business-profile",
    { preHandler: [requireSession, requireRole("owner", "finance")] },
    async (request) => {
      assertOwnMerchant(request);
      const profile = await updateBusinessProfile(app.db, request.params.merchantId, request.body ?? {});
      return profile;
    },
  );
}

function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.auth || request.auth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}
