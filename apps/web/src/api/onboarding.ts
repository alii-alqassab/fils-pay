import { request } from "./client.js";

export type BusinessType =
  | "sole_proprietorship"
  | "llc"
  | "partnership"
  | "public_company"
  | "other";

export interface BusinessProfileInput {
  legalName: string;
  registrationNumber: string;
  businessType: BusinessType;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  city: string;
}

export interface BusinessProfile extends BusinessProfileInput {
  merchantId: string;
  country: string;
  addressLine2: string | null;
  postalCode: string | null;
  updatedAt: string;
}

export interface KycDocument {
  id: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
}

export function registerMerchant(input: {
  businessProfile: BusinessProfileInput;
  owner: { email: string; password: string };
}): Promise<{ merchantId: string; ownerUserId: string; onboardingStatus: string }> {
  return request("/v1/merchants", { method: "POST", body: JSON.stringify(input) });
}

export function getBusinessProfile(merchantId: string): Promise<BusinessProfile> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/business-profile`);
}

export function listKycDocuments(merchantId: string): Promise<KycDocument[]> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/kyc/documents`);
}

export async function uploadKycDocument(
  merchantId: string,
  documentType: string,
  file: File,
): Promise<unknown> {
  const body = new FormData();
  body.append("documentType", documentType);
  body.append("file", file);
  const response = await fetch(
    `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000"}/v1/merchants/${encodeURIComponent(merchantId)}/kyc/documents`,
    { method: "POST", credentials: "include", body },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message ?? result?.error ?? "Upload failed");
  return result;
}
