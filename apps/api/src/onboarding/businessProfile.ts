import type { Pool } from "pg";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { todayStamp } from "../lib/dateUtil.js";
import { withTransaction } from "../db/withTransaction.js";

export interface BusinessProfile {
  merchantId: string;
  legalName: string;
  registrationNumber: string;
  businessType: "sole_proprietorship" | "llc" | "partnership" | "public_company" | "other";
  country: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  updatedAt: Date;
}

interface BusinessProfileRow {
  merchant_id: string;
  legal_name: string;
  registration_number: string;
  business_type: BusinessProfile["businessType"];
  country: string;
  contact_email: string;
  contact_phone: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postal_code: string | null;
  updated_at: Date;
}

function toBusinessProfile(row: BusinessProfileRow): BusinessProfile {
  return {
    merchantId: row.merchant_id,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    businessType: row.business_type,
    country: row.country,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    updatedAt: row.updated_at,
  };
}

/** @returns null when the merchant has no profile yet. */
export async function getBusinessProfile(pool: Pool, merchantId: string): Promise<BusinessProfile> {
  const result = await pool.query<BusinessProfileRow>(
    `SELECT merchant_id, legal_name, registration_number, business_type, country,
            contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at
       FROM merchant_business_profiles
      WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  return toBusinessProfile(row);
}

export interface BusinessProfilePatch {
  legalName?: string;
  registrationNumber?: string;
  businessType?: BusinessProfile["businessType"];
  country?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  postalCode?: string | null;
}

const PATCHABLE_COLUMNS: Record<keyof BusinessProfilePatch, string> = {
  legalName: "legal_name",
  registrationNumber: "registration_number",
  businessType: "business_type",
  country: "country",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  postalCode: "postal_code",
};

const BUSINESS_TYPES = ["sole_proprietorship", "llc", "partnership", "public_company", "other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 255;
const NULLABLE_KEYS = new Set<string>(["addressLine2", "postalCode"]);

/** Validates and normalises a raw PATCH body into [column, value] pairs.
 *  Unknown or inherited keys (foo, constructor, __proto__) are rejected with
 *  400; nothing user-controlled ever reaches the SQL text. */
function validatePatch(raw: unknown): Array<[string, string | null]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("invalid_request", "body must be a JSON object");
  }
  const out: Array<[string, string | null]> = [];
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(PATCHABLE_COLUMNS, key)) {
      throw new BadRequestError("unknown_field", `unknown field: ${key.slice(0, 50)}`);
    }
    let value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value === null) {
      if (!NULLABLE_KEYS.has(key)) throw new BadRequestError("invalid_request", `${key} cannot be null`);
      out.push([PATCHABLE_COLUMNS[key as keyof BusinessProfilePatch], null]);
      continue;
    }
    if (typeof value !== "string") throw new BadRequestError("invalid_request", `${key} must be a string`);
    value = value.trim();
    if (value === "" && !NULLABLE_KEYS.has(key)) throw new BadRequestError("invalid_request", `${key} cannot be empty`);
    if ((value as string).length > MAX_FIELD_LENGTH) throw new BadRequestError("invalid_request", `${key} is too long`);
    if (key === "businessType" && !BUSINESS_TYPES.includes(value as string)) {
      throw new BadRequestError("invalid_business_type");
    }
    if (key === "contactEmail") {
      if (!EMAIL_RE.test(value as string)) throw new BadRequestError("invalid_email");
      value = (value as string).toLowerCase();
    }
    if (key === "country" && !/^[A-Z]{2}$/.test(value as string)) throw new BadRequestError("invalid_country");
    out.push([PATCHABLE_COLUMNS[key as keyof BusinessProfilePatch], value as string]);
  }
  return out;
}

/** The fields that identify the legal entity KYC approved. Changing one of them invalidates
 *  that approval. */
const IDENTITY_COLUMNS = new Set(["legal_name", "registration_number"]);

/** Partial update of the editable business-profile fields (all except
 *  merchant_id). Changing the legal name or registration number of an
 *  approved merchant sends it back to `under_review` so the new identity is
 *  re-checked; other fields do not affect approval state. */
// Column names come from PATCHABLE_COLUMNS, looked up only for own keys
// (Object.hasOwn) after validatePatch; never from raw user input.
export async function updateBusinessProfile(
  pool: Pool,
  merchantId: string,
  patch: BusinessProfilePatch,
): Promise<BusinessProfile> {
  const entries = validatePatch(patch);

  if (entries.length === 0) {
    return getBusinessProfile(pool, merchantId);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [merchantId];
  for (const [column, value] of entries) {
    params.push(value);
    setClauses.push(`${column} = $${params.length}`);
  }
  const touchesIdentity = entries.some(([column]) => IDENTITY_COLUMNS.has(column));

  const row = await withTransaction(pool, async (client) => {
    const current = touchesIdentity
      ? await client.query<{ legal_name: string; registration_number: string }>(
          `SELECT legal_name, registration_number FROM merchant_business_profiles WHERE merchant_id = $1 FOR UPDATE`,
          [merchantId],
        )
      : null;
    const result = await client.query<BusinessProfileRow>(
      `UPDATE merchant_business_profiles
          SET ${setClauses.join(", ")}, updated_at = now()
        WHERE merchant_id = $1
        RETURNING merchant_id, legal_name, registration_number, business_type, country,
                  contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at`,
      params,
    );
    const updated = result.rows[0];
    const before = current?.rows[0];
    if (updated && before && (before.legal_name !== updated.legal_name || before.registration_number !== updated.registration_number)) {
      await client.query(
        `UPDATE merchants SET onboarding_status = 'under_review', kyc_passed = false
          WHERE id = $1 AND onboarding_status = 'approved'`,
        [merchantId],
      );
    }
    return updated;
  });
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  console.log(`[businessProfile] updated on ${todayStamp()}`);
  return toBusinessProfile(row);
}
