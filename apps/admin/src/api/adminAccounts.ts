import { request, requestNoContent } from "./client.js";
import type {
  AcceptInviteResult,
  AdminAccount,
  AdminAccountsResponse,
  AdminInvite,
  AssignableAdminRole,
} from "../types.js";

/** `GET /v1/admin/admins` (master only). */
export function listAdminAccounts(): Promise<AdminAccountsResponse> {
  return request("/v1/admin/admins");
}

/** `POST /v1/admin/admins/invites` → `201 { invite }`. Emails a one-time link; 503 if the email cannot be sent. */
export function inviteAdmin(input: {
  email: string;
  displayName: string;
  role: AssignableAdminRole;
}): Promise<{ invite: AdminInvite }> {
  return request("/v1/admin/admins/invites", { method: "POST", body: JSON.stringify(input) });
}

/** `POST /v1/admin/admins/invites/:id/resend` → `{ invite }` (new link, old one dies). */
export function resendInvite(inviteId: string): Promise<{ invite: AdminInvite }> {
  return request(`/v1/admin/admins/invites/${inviteId}/resend`, { method: "POST" });
}

/** `DELETE /v1/admin/admins/invites/:id` (`204`). */
export function revokeInvite(inviteId: string): Promise<void> {
  return requestNoContent(`/v1/admin/admins/invites/${inviteId}`, { method: "DELETE" });
}

/** `PATCH /v1/admin/admins/:id` → `{ admin }`. Never the master or yourself. */
export function updateAdminAccount(
  adminId: string,
  change: { role?: AssignableAdminRole; status?: "active" | "disabled" },
): Promise<{ admin: AdminAccount }> {
  return request(`/v1/admin/admins/${adminId}`, { method: "PATCH", body: JSON.stringify(change) });
}

/** `POST /v1/admin/admins/:id/reset` → `201 { invite }`: emails a password-reset link. */
export function sendAdminReset(adminId: string): Promise<{ invite: AdminInvite }> {
  return request(`/v1/admin/admins/${adminId}/reset`, { method: "POST" });
}

/** `POST /v1/admin/auth/accept-invite` (public). Does not sign anyone in. */
export function acceptInvite(input: { token: string; password: string }): Promise<AcceptInviteResult> {
  return request("/v1/admin/auth/accept-invite", { method: "POST", body: JSON.stringify(input) });
}
