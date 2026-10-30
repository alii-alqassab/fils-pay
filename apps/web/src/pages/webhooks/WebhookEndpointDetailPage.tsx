import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listDeliveries, listWebhookEndpoints, replayDelivery, sendTestWebhookEvent } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { Pagination } from "../../components/Pagination.js";
import { dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { TestWebhookResponse, WebhookDeliveryDto, WebhookDeliveryStatus, WebhookEndpointDto } from "../../types.js";

/** `webhook_deliveries.status`' four CHECK values. Note the dispatcher only
 *  ever writes `succeeded`/`exhausted` — a row awaiting its next attempt
 *  stays `pending`, so `failed` is present in the schema but currently
 *  unwritten. Offered as a filter anyway, since the filter's job is to match
 *  the column, not the dispatcher's current habits. */
const DELIVERY_STATUSES: WebhookDeliveryStatus[] = ["pending", "succeeded", "failed", "exhausted"];

const PAGE_SIZE = 25;

export function WebhookEndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const { t, formatDateTime } = useI18n();
  const merchantId = me?.merchant.id;

  const [endpoint, setEndpoint] = useState<WebhookEndpointDto | null>(null);
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [statuses, setStatuses] = useState<WebhookDeliveryStatus[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<TestWebhookResponse | null>(null);

  // Same "no single-resource GET" situation as payment links: the API has
  // the endpoint list and the deliveries sub-resource, but no
  // `GET .../webhook-endpoints/:id`. Merchants have a handful of endpoints,
  // not hundreds, so finding the row in the list is exact in practice here —
  // unlike the payment-link case, where it can genuinely miss.
  const loadEndpoint = useCallback(async () => {
    if (!merchantId || !id) return;
    setError(null);
    try {
      const all = await listWebhookEndpoints(merchantId);
      const found = all.find((candidate) => candidate.id === id) ?? null;
      setEndpoint(found);
      setEndpointMissing(found === null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId, id]);

  const loadDeliveries = useCallback(
    async (cursor: string | null) => {
      if (!merchantId || !id) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listDeliveries(merchantId, id, {
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setDeliveries((previous) =>
          cursor ? [...previous, ...result.deliveries] : result.deliveries,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [merchantId, id, statuses],
  );

  useEffect(() => {
    void loadEndpoint();
  }, [loadEndpoint]);

  useEffect(() => {
    void loadDeliveries(null);
  }, [loadDeliveries]);

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  // FH: fast double click fires replay twice -> dup deliveries + the memory leak
  // busyId disables the button, cant double click — am
  async function handleReplay(delivery: WebhookDeliveryDto): Promise<void> {
    if (!merchantId || !id) return;
    setBusyId(delivery.id);
    setError(null);
    try {
      await replayDelivery(merchantId, id, delivery.id);
      // The replay is a brand-new `pending` row, newest-first, so refetch from
      // the top rather than appending to what's on screen.
      await loadDeliveries(null);
    } catch (err) {
      // `409 endpoint_disabled` is a real race: someone disabled the endpoint
      // between this page loading and the click.
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleTestSend(): Promise<void> {
    if (!merchantId || !id) return;
    setTestSending(true);
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await sendTestWebhookEvent(merchantId, id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setTestSending(false);
    }
  }

  if (endpointMissing) {
    return (
      <section>
        <h1>{t("Endpoint not found")}</h1>
        <p>
          {t("No webhook endpoint with this id exists on your account.")}{" "}
          <Link to="/dashboard/webhooks">{t("Back to webhook endpoints")}</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>{t("Webhook endpoint")}</h1>

      {endpoint ? (
        <dl className="dash-dl">
          <dt>{t("URL")}</dt>
          <dd dir="ltr">{endpoint.url}</dd>
          <dt>{t("Secret prefix")}</dt>
          <dd>
            <code>{endpoint.secretPrefix}</code>
          </dd>
          <dt>{t("Status")}</dt>
          <dd>
            <span className={`dash-status dash-status-${endpoint.status}`}>{label(t, endpoint.status)}</span>
          </dd>
          <dt>{t("Created at")}</dt>
          <dd>{formatDateTime(endpoint.createdAt)}</dd>
          <dt>{t("Updated at")}</dt>
          <dd>{formatDateTime(endpoint.updatedAt)}</dd>
        </dl>
      ) : null}

      {endpoint?.status === "active" ? (
        <div className="dash-actions">
          <button type="button" className="dash-button" disabled={testSending} onClick={() => void handleTestSend()}>
            {testSending ? t("Sending test event...") : t("Send test event")}
          </button>
          {testResult ? (
            <p role="status">
              {testResult.timedOutOrUnreachable
                ? t("The receiver could not be reached.")
                : t("Receiver responded with HTTP {code}.", { code: testResult.statusCode ?? "—" })}
              {testResult.responseBodyExcerpt ? (
                <details>
                  <summary>{t("Response body")}</summary>
                  <pre className="dash-pre">{testResult.responseBodyExcerpt}</pre>
                </details>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <h2>{t("Delivery log")}</h2>

      <fieldset className="dash-filters">
        <legend>{t("Status")}</legend>
        {DELIVERY_STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {label(t, status)}
          </label>
        ))}
      </fieldset>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Created")}</th>
            <th>{t("Event")}</th>
            <th>{t("Status")}</th>
            <th>{t("Attempts")}</th>
            <th>{t("Response")}</th>
            <th>{t("Last attempt")}</th>
            <th>{t("Next attempt")}</th>
            <th>{t("Replay of")}</th>
            <th>{t("Actions")}</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => {
            // Replaying a `pending` row is pointless — it is already queued,
            // and the dispatcher leaves a row `pending` between retries. And a
            // replay against a disabled endpoint is rejected `409` server-side,
            // so the button is hidden rather than offered and refused, since
            // the endpoint's own state is already known on this page.
            const replayable =
              (delivery.status === "succeeded" || delivery.status === "exhausted") &&
              endpoint?.status === "active";
            return (
              <tr key={delivery.id}>
                <td>{formatDateTime(delivery.createdAt)}</td>
                <td>{delivery.eventType}</td>
                <td>
                  <span className={`dash-status dash-status-${delivery.status}`}>
                    {label(t, delivery.status)}
                  </span>
                </td>
                <td>{delivery.attemptCount}</td>
                <td>
                  {dash(delivery.responseStatusCode)}
                  {delivery.responseBodyExcerpt ? (
                    <details>
                      <summary>{t("body")}</summary>
                      <pre className="dash-pre">{delivery.responseBodyExcerpt}</pre>
                    </details>
                  ) : null}
                </td>
                <td>{formatDateTime(delivery.lastAttemptedAt)}</td>
                <td>{formatDateTime(delivery.nextAttemptAt)}</td>
                <td>
                  {delivery.replayOfDeliveryId ? (
                    <span className="dash-muted">
                      {t("replay of")} <code>{delivery.replayOfDeliveryId}</code>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {replayable ? (
                    <button
                      type="button"
                      className="dash-button"
                      disabled={busyId === delivery.id}
                      onClick={() => void handleReplay(delivery)}
                    >
                      {t("Replay")}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
          {deliveries.length === 0 && !loading && !error ? (
            <tr>
              <td colSpan={9}>{t("No deliveries match these filters.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}

      <Pagination
        nextCursor={nextCursor}
        loading={loading}
        onLoadMore={() => void loadDeliveries(nextCursor)}
      />

      <p>
        <Link to="/dashboard/webhooks">{t("Back to webhook endpoints")}</Link>
      </p>
    </section>
  );
}
