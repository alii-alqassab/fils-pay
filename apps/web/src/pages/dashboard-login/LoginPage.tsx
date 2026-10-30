import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError, describeError } from "../../api/client.js";
import { loginErrorMessage } from "../../utils/loginErrors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse } from "../../types.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { LanguageToggle } from "../../i18n/LanguageToggle.js";
import { tk } from "../../i18n/translate.js";
import "../../dashboard.css";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: DashboardLoginResponse };

/**
 * Two-step merchant login: email + password
 * creates a *pending* session and issues an OTP challenge; the OTP step is
 * what actually authenticates it. Neither step is told which credential was
 * wrong — the API answers a single generic `invalid_credentials`, and this
 * screen repeats it verbatim rather than guessing at something more specific.
 *
 * If the same credentials belong to multiple merchants, the API returns
 * merchant names after verifying the password so the user can choose one.
 */
export function LoginPage() {
  const { status, refresh } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, formatTime } = useI18n();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [merchantChoices, setMerchantChoices] = useState<Array<{ id: string; displayName: string }>>([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState("");
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/dashboard/transactions";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setCode("");
    setError(message);
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await login({
        merchantId: selectedMerchantId || undefined,
        email: email.trim(),
        password,
      });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "merchant_selection_required") {
        const options = err.body.merchants;
        if (Array.isArray(options)) {
          const merchants = options.filter((item): item is { id: string; displayName: string } =>
            !!item && typeof item.id === "string" && typeof item.displayName === "string");
          setMerchantChoices(merchants);
          setSelectedMerchantId(merchants[0]?.id ?? "");
        }
      }
      setError((err instanceof ApiError ? loginErrorMessage(err.code, err.statusCode) : null) ?? describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? — am
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      // The session cookie is now authenticated server-side; re-read `me` so
      // the rest of the dashboard renders from the server's answer, not from
      // the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // `429 too_many_attempts` revokes the pending session server-side, so
      // retrying the OTP step against it can only ever fail again — start
      // over instead of leaving the user tapping a dead form.
      if (err instanceof ApiError && err.statusCode === 429 && err.code === "too_many_attempts") {
        backToCredentials(describeError(err));
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await resendOtp();
      setStep({ kind: "otp", challenge });
      setCode("");
      setNotice(tk("A new code has been sent."));
    } catch (err) {
      // Includes `429 resend_too_soon` — the server owns the cadence rule, so
      // whatever it says is shown as-is rather than pre-empted by a
      // client-side timer that could drift from it.
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dash-centered">
      <LanguageToggle className="dash-button dash-lang-inline" />
      <h1>{t("FilsPay dashboard")}</h1>
      <p className="dash-muted">{t("Company sign-in.")}</p>
      {(location.state as { registered?: boolean } | null)?.registered ? (
        <p className="dash-notice">{t("Company account created. Sign in to upload verification documents. Your company needs admin approval before it can take payments.")}</p>
      ) : null}

      {error ? <p className="dash-error">{t(error)}</p> : null}
      {notice ? <p className="dash-notice">{t(notice)}</p> : null}

      {step.kind === "credentials" ? (
        <form onSubmit={(e) => void handleCredentials(e)} className="dash-form">
          <label>
            {t("Email")}
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setMerchantChoices([]);
                setSelectedMerchantId("");
              }}
            />
          </label>
          <label>
            {t("Password")}
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setMerchantChoices([]);
                setSelectedMerchantId("");
              }}
            />
          </label>
          {merchantChoices.length > 0 ? (
            <label>
              {t("Business")}
              <select
                required
                value={selectedMerchantId}
                onChange={(e) => setSelectedMerchantId(e.target.value)}
              >
                {merchantChoices.map((merchant) => (
                  <option key={merchant.id} value={merchant.id}>{merchant.displayName}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="submit" className="dash-button" disabled={submitting}>
            {submitting ? t("Signing in...") : t("Continue")}
          </button>
          <p>{t("New to FilsPay?")} <Link to="/dashboard/register">{t("Register your company")}</Link>.</p>
          <p>{t("Joining a colleague's company?")} <Link to="/dashboard/join">{t("Join a company with its company ID")}</Link>.</p>
        </form>
      ) : (
        <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
          <p>
            {t("We emailed a 6-digit code to")} <bdi><strong>{email}</strong></bdi>. {t("It expires at")}{" "}
            {formatTime(step.challenge.otpExpiresAt)}.
          </p>
          {/* Only present when the API runs with a dev OTP mode; real deployments never return it. */}
          {step.challenge.devOtpCode ? (
            <p className="dash-muted">
              {t("Development code:")} <code>{step.challenge.devOtpCode}</code>
            </p>
          ) : null}
          <label>
            {t("One-time code")}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="dash-button" disabled={submitting}>
            {submitting ? t("Verifying...") : t("Verify")}
          </button>
          <button
            type="button"
            className="dash-button"
            disabled={submitting}
            onClick={() => void handleResend()}
          >
            {t("Resend code")}
          </button>
          <button type="button" className="dash-button" onClick={() => backToCredentials(null)}>
            {t("Start over")}
          </button>
        </form>
      )}
    </main>
  );
}
