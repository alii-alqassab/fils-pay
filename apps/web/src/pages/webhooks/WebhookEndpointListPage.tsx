import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { WebhookEndpointDto } from "../../types.js";

/**
 * `GET /v1/merchants/:merchantId/webhook-endpoints`. Unlike most
 * list reads in this platform, this one is `owner`/`finance` only
 * server-side — so a `support` user reaching this page gets a real `403`,
 * which `describeError` renders plainly. The nav link is hidden from them too
 * (DashboardLayout), but a typed URL still lands here, and it must explain
 * itself rather than sit on a blank loading state.
 */
export function WebhookEndpointListPage() {
  const { me } = useDashboardAuth();
  const { t, formatDateTime } = useI18n();
  const merchantId = me?.merchant.id;

  const [endpoints, setEndpoints] = useState<WebhookEndpointDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      setEndpoints(await listWebhookEndpoints(merchantId));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    setBusyId(endpoint.id);
    setError(null);
    try {
      await updateWebhookEndpoint(merchantId, endpoint.id, {
        status: endpoint.status === "active" ? "disabled" : "active",
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  // delete 500s if the endpoint has deliveries — am
  // MK: fixed in FP-240
  async function handleDelete(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    // A hard delete — the endpoint row is gone, while its delivery log
    // outlives it. Irreversible, so it asks first.
    if (
      !window.confirm(
        t("Delete {url}? This cannot be undone, and its secret cannot be recovered.", { url: endpoint.url }),
      )
    ) {
      return;
    }
    setBusyId(endpoint.id);
    setError(null);
    try {
      await deleteWebhookEndpoint(merchantId, endpoint.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h1>{t("Webhook endpoints")}</h1>

      <p>
        <Link className="dash-button-link" to="/dashboard/webhooks/new">
          {t("New endpoint")}
        </Link>
      </p>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("URL")}</th>
            <th>{t("Secret prefix")}</th>
            <th>{t("Status")}</th>
            <th>{t("Created")}</th>
            <th>{t("Actions")}</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((endpoint) => (
            <tr key={endpoint.id}>
              <td>
                <Link to={`/dashboard/webhooks/${endpoint.id}`} dir="ltr">{endpoint.url}</Link>
              </td>
              <td>
                <code>{endpoint.secretPrefix}</code>
              </td>
              <td>
                <span className={`dash-status dash-status-${endpoint.status}`}>{label(t, endpoint.status)}</span>
              </td>
              <td>{formatDateTime(endpoint.createdAt)}</td>
              <td>
                <button
                  type="button"
                  className="dash-button"
                  disabled={busyId === endpoint.id}
                  onClick={() => void handleToggle(endpoint)}
                >
                  {endpoint.status === "active" ? t("Disable") : t("Enable")}
                </button>{" "}
                <button
                  type="button"
                  className="dash-button"
                  disabled={busyId === endpoint.id}
                  onClick={() => void handleDelete(endpoint)}
                >
                  {t("Delete")}
                </button>
              </td>
            </tr>
          ))}
          {endpoints.length === 0 && !loading && !error ? (
            <tr>
              <td colSpan={5}>{t("No webhook endpoints registered.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}
    </section>
  );
}
