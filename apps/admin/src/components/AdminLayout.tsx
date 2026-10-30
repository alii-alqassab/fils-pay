import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { useI18n } from "../i18n/I18nProvider.js";
import { LanguageToggle } from "../i18n/LanguageToggle.js";
import { label } from "../i18n/labels.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="admin-shell">
      <ImpersonationBanner />

      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-brand-name">FilsPay</span>
          <small>{t("admin")}</small>
        </div>
        <nav className="admin-nav">
          <NavLink to="/merchants">{t("Merchants")}</NavLink>
          <NavLink to="/credits">{t("Credits")}</NavLink>
          <NavLink to="/settlement">{t("Settlement ops")}</NavLink>
          <NavLink to="/adjustment-imports">{t("Import adjustments")}</NavLink>
          <NavLink to="/webhooks">{t("Webhook replay")}</NavLink>
          {admin?.role === "master" ? <NavLink to="/admins">{t("Admins")}</NavLink> : null}
        </nav>
        <div className="admin-identity">
          {admin ? (
            <span>
              <bdi>{admin.email}</bdi> <span className="admin-role-chip">{label(t, admin.role)}</span>
            </span>
          ) : null}
          <LanguageToggle />
          <button type="button" onClick={() => void handleSignOut()}>
            {t("Log out")}
          </button>
        </div>
      </header>

      {error ? <p className="admin-error">{t(error)}</p> : null}

      {impersonation ? (
        // An explicit "exit view-as-merchant" action is required before
        // admin-plane screens are shown again. This is a UX safeguard so the
        // two modes are never confused on screen; the privilege boundary
        // itself does not depend on it — /v1/admin/* never reads the
        // impersonation cookie, and the merchant side never reads the admin
        // session cookie.
        <main className="admin-main">
          <h1>{t("Admin screens are paused")}</h1>
          <p>
            {t("An impersonation grant is active. Use “Exit impersonation” above to end it and return to the admin console.")}
          </p>
          <p>
            {t("Merchant screens are at")} <code>{WEB_BASE_URL}</code> {t("while the grant lasts.")}
          </p>
        </main>
      ) : (
        <main className="admin-main">
          <Outlet />
        </main>
      )}
    </div>
  );
}
