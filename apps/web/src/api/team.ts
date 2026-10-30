import { request } from "./client.js";
import type { TeamMember } from "../types.js";

export type StaffRole = "finance" | "support";

/** Public: a colleague asks to join a company by its ID. The account waits for the owner. */
export function joinCompany(input: {
  companyCode: string;
  fullName: string;
  email: string;
  password: string;
  requestedRole: StaffRole;
}): Promise<{ status: "pending_owner_approval" }> {
  return request("/v1/company-join", { method: "POST", body: JSON.stringify(input) });
}

/** Owner only. */
export function listTeam(): Promise<{ members: TeamMember[] }> {
  return request("/v1/team");
}

export function approveMember(userId: string, role: StaffRole): Promise<TeamMember> {
  return request(`/v1/team/${encodeURIComponent(userId)}/approve`, { method: "POST", body: JSON.stringify({ role }) });
}

export function rejectMember(userId: string): Promise<TeamMember> {
  return request(`/v1/team/${encodeURIComponent(userId)}/reject`, { method: "POST" });
}

export function updateMember(
  userId: string,
  change: { role?: StaffRole; status?: "active" | "disabled" },
): Promise<TeamMember> {
  return request(`/v1/team/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(change) });
}
