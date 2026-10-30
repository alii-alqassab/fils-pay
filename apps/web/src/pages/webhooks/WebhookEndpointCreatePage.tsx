import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createWebhookEndpoint } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { WebhookEndpointCreateResponse } from "../../types.js";

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints`.
 *
 * The `201` response is the only time the signing secret is ever returned —
 * it is stored encrypted at rest (not hashed, because each delivery's HMAC
 * needs the plaintext back) and no read endpoint returns it again. So this
 * page never navigates away on its own: the merchant has to acknowledge the
 * secret panel, which is what stops an accidental redirect or back-button
 * from losing a credential that cannot be re-issued.
 */
export function WebhookEndpointCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();
  const { t, formatDateTime } = useI18n();

  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebhookEndpointCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  /** The response carries the secret; this is the only time it is shown. */
  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setSubmitting(true);
    setError(null);
    try {
      setCreated(await createWebhookEndpoint(me.merchant.id, { url: url.trim() }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // MK: secret is shown once only
  async function handleCopy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // The secret is on screen and selectable — nothing to recover from.
      setCopied(false);
    }
  }

  if (created) {
    return (
      <section>
        <h1>{t("Endpoint created")}</h1>

        <div className="dash-confirm">
          <h2>{t("Signing secret — shown once")}</h2>
          <p>
            <strong>{t("This will not be shown again.")}</strong>{" "}
            {t("Store it now; every delivery to this endpoint is signed with it, and it cannot be re-read or recovered.")}
          </p>
          <p>
            <code className="dash-secret">{created.secret}</code>{" "}
            <button
              type="button"
              className="dash-button"
              onClick={() => void handleCopy(created.secret)}
            >
              {copied ? t("Copied") : t("Copy secret")}
            </button>
          </p>
        </div>

        <dl className="dash-dl">
          <dt>{t("URL")}</dt>
          <dd dir="ltr">{created.url}</dd>
          <dt>{t("Secret prefix")}</dt>
          <dd>
            <code>{created.secretPrefix}</code>
          </dd>
          <dt>{t("Status")}</dt>
          <dd>{label(t, created.status)}</dd>
          <dt>{t("Created at")}</dt>
          <dd>{formatDateTime(created.createdAt)}</dd>
        </dl>

        <button
          type="button"
          className="dash-button"
          onClick={() => navigate(`/dashboard/webhooks/${created.id}`, { replace: true })}
        >
          {t("I've saved it — continue")}
        </button>
      </section>
    );
  }

  return (
    <section>
      <h1>{t("New webhook endpoint")}</h1>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          {t("Endpoint URL")}
          <input
            type="url"
            required
            placeholder="https://example.com/filspay/webhooks"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button" disabled={submitting}>
          {submitting ? t("Creating...") : t("Create endpoint")}
        </button>
      </form>

      <p>
        <Link to="/dashboard/webhooks">{t("Back to webhook endpoints")}</Link>
      </p>
    </section>
  );
}
