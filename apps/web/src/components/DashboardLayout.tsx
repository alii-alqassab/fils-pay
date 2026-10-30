import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import { useI18n } from "../i18n/I18nProvider.js";
import { LanguageToggle } from "../i18n/LanguageToggle.js";
import { label } from "../i18n/labels.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <header className="dash-header">
        <div className="dash-brand">FilsPay</div>
        <nav className="dash-nav">
          <NavLink to="/dashboard/onboarding">{t("Business verification")}</NavLink>
          <NavLink to="/dashboard/transactions">{t("Transactions")}</NavLink>
          <NavLink to="/dashboard/payment-links">{t("Payment links")}</NavLink>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">{t("Webhooks")}</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/settlement">{t("Settlement")}</NavLink>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">{t("Reconciliation")}</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/overview">{t("Overview")}</NavLink>
          {/* Team management is owner-only server-side. */}
          {me?.role === "owner" ? <NavLink to="/dashboard/team">{t("Team")}</NavLink> : null}
        </nav>
        <div className="dash-identity">
          {me ? (
            <span>
              <bdi>{me.email}</bdi> <span className="dash-role-chip">{label(t, me.role)}</span>
              <span className="dash-muted"> · {me.merchant.displayName}</span>
            </span>
          ) : null}
          <LanguageToggle className="dash-button" />
          <button type="button" className="dash-button" onClick={() => void handleSignOut()}>
            {t("Log out")}
          </button>
        </div>
      </header>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <main className="dash-main">
        <Outlet />
      </main>
    </div>
  );
}
