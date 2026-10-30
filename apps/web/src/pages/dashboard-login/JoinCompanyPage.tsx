import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { describeError, ApiError } from "../../api/client.js";
import { joinCompany, type StaffRole } from "../../api/team.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { normalizeCompanyCode } from "../../utils/companyCode.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { LanguageToggle } from "../../i18n/LanguageToggle.js";
import { tk } from "../../i18n/translate.js";
import "../../dashboard.css";

function describeJoinError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "company_not_found") return tk("We could not find an active company with that ID. Check it with your company owner.");
    if (err.code === "already_requested") return tk("This email already has an account or a request for this company.");
    if (err.code === "too_many_pending") return tk("This company has too many open requests. Ask the owner to review them first.");
    if (err.code === "weak_password") return tk("Use a password of at least 12 characters.");
    if (err.statusCode === 429) return tk("Too many attempts. Please try again later.");
  }
  return describeError(err);
}

/** Public page: a colleague asks to join an existing company using its company ID. */
export function JoinCompanyPage() {
  const { status } = useDashboardAuth();
  const { t } = useI18n();
  const [companyCode, setCompanyCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [requestedRole, setRequestedRole] = useState<StaffRole>("support");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (status === "authenticated") return <Navigate to="/dashboard/transactions" replace />;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const code = normalizeCompanyCode(companyCode);
    if (!code) {
      setError(tk("That does not look like a company ID. It looks like FP-7K3M-9QXA."));
      return;
    }
    if (password.length < 12) {
      setError(tk("Use a password of at least 12 characters."));
      return;
    }
    if (password !== confirmPassword) {
      setError(tk("Passwords do not match."));
      return;
    }
    setBusy(true);
    try {
      await joinCompany({ companyCode: code, fullName: fullName.trim(), email: email.trim(), password, requestedRole });
      setSent(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(describeJoinError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="dash-centered">
        <LanguageToggle className="dash-button dash-lang-inline" />
        <h1>{t("Request sent")}</h1>
        <p className="dash-notice" role="status">
          {t("Request sent. The company owner must approve it before you can sign in. We emailed the owner; you will be told the result by email at")}{" "}
          <bdi><strong>{email.trim()}</strong></bdi>.
        </p>
        <p><Link to="/dashboard/login">{t("Back to sign in")}</Link></p>
      </main>
    );
  }

  return (
    <main className="dash-centered">
      <LanguageToggle className="dash-button dash-lang-inline" />
      <h1>{t("Join a company")}</h1>
      <p className="dash-muted">
        {t("Ask your company owner for the company ID (it looks like FP-7K3M-9QXA). The owner approves your request before you can sign in.")}
      </p>
      {error ? <p className="dash-error" role="alert">{t(error)}</p> : null}
      <form className="dash-form" onSubmit={(event) => void submit(event)}>
        <label>{t("Company ID")}<input required autoComplete="off" placeholder="FP-XXXX-XXXX" value={companyCode} onChange={(event) => setCompanyCode(event.target.value)} /></label>
        <label>{t("Full name")}<input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
        <label>{t("Work email")}<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>{t("Password")}<input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>{t("Confirm password")}<input type="password" required minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <label>{t("Role you need")}
          <select value={requestedRole} onChange={(event) => setRequestedRole(event.target.value as StaffRole)}>
            <option value="support">{t("Support (look things up)")}</option>
            <option value="finance">{t("Finance (payment links, webhooks, settlement)")}</option>
          </select>
        </label>
        <button className="dash-button" type="submit" disabled={busy}>{busy ? t("Sending request...") : t("Send request")}</button>
      </form>
      <p>{t("Already have an account?")} <Link to="/dashboard/login">{t("Sign in")}</Link>.</p>
      <p>{t("Registering a new company instead?")} <Link to="/dashboard/register">{t("Create a company account")}</Link>.</p>
    </main>
  );
}
