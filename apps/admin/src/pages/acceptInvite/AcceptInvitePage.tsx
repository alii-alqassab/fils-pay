import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { acceptInvite } from "../../api/adminAccounts.js";
import { ApiError, describeError } from "../../api/client.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { LanguageToggle } from "../../i18n/LanguageToggle.js";
import { tk } from "../../i18n/translate.js";

// The translated messages below spell out "12"; keep them in step with this.
const MIN_LENGTH = 12;

/**
 * Public page (outside the auth guard) reached from the invitation or
 * password-reset email: `/accept-invite?token=...`. The person chooses a
 * password; the one-time token is the only credential. It does not sign
 * them in: they continue to /login (password, then an emailed code).
 */
export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const { t } = useI18n();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) {
      setError(tk("Password must be at least 12 characters."));
      return;
    }
    if (password !== confirm) {
      setError(tk("The two passwords do not match."));
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvite({ token, password });
      setDone(true);
      setPassword("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_invite") {
        setError(tk("This link is invalid or has expired. Ask the master administrator to send a new one."));
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="admin-centered">
      <LanguageToggle className="admin-lang-inline" />
      <h1>{t("FilsPay Admin")}</h1>
      {done ? (
        <>
          <p className="admin-notice">{t("Password set - you can sign in now.")}</p>
          <p>
            <Link to="/login">{t("Go to sign in")}</Link>
          </p>
        </>
      ) : !token ? (
        <p className="admin-error">{t("This link is missing its token. Open the link from your email again.")}</p>
      ) : (
        <>
          <p className="admin-muted">{t("Choose a password for your admin account.")}</p>
          {error ? <p className="admin-error">{t(error)}</p> : null}
          <form onSubmit={(e) => void handleSubmit(e)} className="admin-form">
            <label>
              {t("New password (at least 12 characters)")}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              {t("Confirm password")}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_LENGTH}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? t("Saving...") : t("Set password")}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
