import type { ReactNode } from "react";
import { useAdminAuth } from "./AdminAuthContext.js";
import type { AdminRole } from "../types.js";

/**
 * A UI-only convenience gate. It is **explicitly not** the security
 * boundary for anything it wraps.
 *
 * Every action in this console is gated server-side by its route's own
 * `requireAdminRole(...)`; that check runs on every request
 * and is the only thing that decides whether an action happens. This
 * component exists so an operator isn't shown a control that would answer
 * `403` — a nicer experience, layered on top of the real gate, never
 * substituting for it.
 *
 * Hence the deliberate default: when the current role is unknown (the `me`
 * call hasn't resolved, or returned an unexpected role), `children` are
 * shown, not hidden. Hiding on uncertainty would quietly turn this into the
 * thing deciding access. The server's `403` is the answer; `describeError`
 * renders it plainly when it comes back.
 */
/**
 * Hides controls; it does not protect anything.
 * — MK
 */
export function RequireRole({
  allow,
  children,
  fallback = null,
}: {
  allow: AdminRole[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { admin } = useAdminAuth();
  // The master can do everything a super_admin can, so it passes wherever
  // super_admin is listed. Master-only controls list "master" alone.
  const allowed = admin
    ? allow.includes(admin.role) || (admin.role === "master" && allow.includes("super_admin"))
    : true;
  if (!allowed) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
