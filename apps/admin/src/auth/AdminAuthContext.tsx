import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { logout as logoutRequest, me as fetchMe } from "../api/auth.js";
import {
  clearActiveImpersonation,
  endImpersonation,
  readActiveImpersonation,
  writeActiveImpersonation,
} from "../api/impersonation.js";
import type { ActiveImpersonation } from "../api/impersonation.js";
import { ApiError } from "../api/client.js";
import type { AdminMe } from "../types.js";

export type AdminAuthStatus = "loading" | "authenticated" | "anonymous";

export interface AdminAuthValue {
  status: AdminAuthStatus;
  /** Non-null exactly when `status === "authenticated"`. */
  admin: AdminMe | null;
  /** Re-runs `GET /v1/admin/auth/me` — called after a successful OTP step. */
  refresh: () => Promise<void>;
  /** `POST /v1/admin/auth/logout`, then drops local state regardless. */
  signOut: () => Promise<void>;
  /** The locally-recorded active impersonation grant, if any. */
  impersonation: ActiveImpersonation | null;
  rememberImpersonation: (record: ActiveImpersonation) => void;
  /** `POST /v1/admin/impersonation/:grantId/end`, then drops the record. */
  exitImpersonation: () => Promise<void>;
}

const AdminAuthReactContext = createContext<AdminAuthValue | null>(null);

/**
 * Holds the answer to "who am I, per the server?" — loaded once on mount
 * from `GET /v1/admin/auth/me`. Nothing in this app treats a value
 * here as authority: every privileged route re-checks the session
 * server-side on every request, and this context exists so the UI can show
 * the right screen, not so it can decide what is allowed.
 */
// admin console memory leak — the impersonation interval is never cleared? — am
// FH: there's a clearInterval in the cleanup. still leaking though??
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AdminAuthStatus>("loading");
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(() =>
    readActiveImpersonation(),
  );

  const refresh = useCallback(async () => {
    try {
      const current = await fetchMe();
      setAdmin(current);
      setStatus("authenticated");
    } catch {
      // Any failure — 401, a revoked session, the API being down — lands the
      // operator on the login screen rather than a half-rendered console.
      setAdmin(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // An impersonation grant has a short, server-enforced lifetime
  // (config.impersonationTtlMinutes, default 15). Re-read the local record
  // on a timer so the banner disappears when the grant behind it expires
  // rather than lingering past it.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setImpersonation(readActiveImpersonation());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const rememberImpersonation = useCallback((record: ActiveImpersonation) => {
    writeActiveImpersonation(record);
    setImpersonation(record);
  }, []);

  const exitImpersonation = useCallback(async () => {
    const current = readActiveImpersonation();
    if (!current) {
      setImpersonation(null);
      return;
    }
    try {
      await endImpersonation(current.grantId);
    } catch (err) {
      // Only drop the banner when the grant is provably gone (404 unknown /
      // 401 session ended). On any other failure (network, 5xx) the grant and
      // its httpOnly cookie may still be live, so keep the banner and let the
      // caller show the error and offer a retry; it still expires on its own.
      if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 401)) {
        clearActiveImpersonation();
        setImpersonation(null);
        return;
      }
      throw err;
    }
    clearActiveImpersonation();
    setImpersonation(null);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      clearActiveImpersonation();
      setImpersonation(null);
      setAdmin(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AdminAuthValue>(
    () => ({
      status,
      admin,
      refresh,
      signOut,
      impersonation,
      rememberImpersonation,
      exitImpersonation,
    }),
    [status, admin, refresh, signOut, impersonation, rememberImpersonation, exitImpersonation],
  );

  return <AdminAuthReactContext.Provider value={value}>{children}</AdminAuthReactContext.Provider>;
}

export function useAdminAuth(): AdminAuthValue {
  const value = useContext(AdminAuthReactContext);
  if (!value) {
    throw new Error("useAdminAuth: must be used inside <AdminAuthProvider>");
  }
  return value;
}
