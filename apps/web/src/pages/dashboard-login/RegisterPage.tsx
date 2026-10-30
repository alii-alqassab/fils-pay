import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { describeError } from "../../api/client.js";
import { registerMerchant, type BusinessType } from "../../api/onboarding.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { LanguageToggle } from "../../i18n/LanguageToggle.js";
import { tk } from "../../i18n/translate.js";
import "../../dashboard.css";

export function RegisterPage() {
  const { status } = useDashboardAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [legalName, setLegalName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("llc");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "authenticated") return <Navigate to="/dashboard/onboarding" replace />;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
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
      await registerMerchant({
        businessProfile: {
          legalName: legalName.trim(),
          registrationNumber: registrationNumber.trim(),
          businessType,
          contactEmail: email.trim(),
          contactPhone: phone.trim(),
          addressLine1: address.trim(),
          city: city.trim(),
        },
        owner: { email: email.trim(), password },
      });
      navigate("/dashboard/login", { replace: true, state: { registered: true, email: email.trim(), from: "/dashboard/onboarding" } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dash-centered">
      <LanguageToggle className="dash-button dash-lang-inline" />
      <h1>{t("Register your company")}</h1>
      <p className="dash-muted">
        {t("This creates a company owner account. The FilsPay team must approve your company before it can take payments; you can upload verification documents after signing in. When it is approved you receive a company ID to share with colleagues.")}
      </p>
      <p>{t("Joining a colleague's company instead?")} <Link to="/dashboard/join">{t("Join an existing company")}</Link>.</p>
      {error ? <p className="dash-error" role="alert">{t(error)}</p> : null}
      <form className="dash-form" onSubmit={(event) => void submit(event)}>
        <label>{t("Legal business name")}<input required value={legalName} onChange={(event) => setLegalName(event.target.value)} /></label>
        <label>{t("Business registration number")}<input required value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} /></label>
        <label>{t("Business type")}
          <select value={businessType} onChange={(event) => setBusinessType(event.target.value as BusinessType)}>
            <option value="llc">{t("Limited liability company")}</option>
            <option value="sole_proprietorship">{t("Sole proprietorship")}</option>
            <option value="partnership">{t("Partnership")}</option>
            <option value="public_company">{t("Public company")}</option>
            <option value="other">{t("Other")}</option>
          </select>
        </label>
        <label>{t("Work email")}<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>{t("Contact phone")}<input type="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <label>{t("Business address")}<input required value={address} onChange={(event) => setAddress(event.target.value)} /></label>
        <label>{t("City")}<input required value={city} onChange={(event) => setCity(event.target.value)} /></label>
        <label>{t("Password")}<input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>{t("Confirm password")}<input type="password" required minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <button className="dash-button" type="submit" disabled={busy}>{busy ? t("Creating account...") : t("Create company account")}</button>
      </form>
      <p>{t("Already have an account?")} <Link to="/dashboard/login">{t("Sign in")}</Link>.</p>
    </main>
  );
}
