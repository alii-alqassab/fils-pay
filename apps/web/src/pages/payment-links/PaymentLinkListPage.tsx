import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { PaymentLinkDto, PaymentLinkStatus } from "../../types.js";

/** The four *stored* statuses, including `reserved` — the merchant-facing
 *  list deliberately exposes it distinctly rather than collapsing it into the
 *  public enum's `processing`, because a merchant needs to see that a link is
 *  mid-payment-attempt. */
const STATUSES: PaymentLinkStatus[] = ["active", "reserved", "paid", "canceled"];

const PAGE_SIZE = 25;

/**
 * Keyset paginated, newest first.
 * — FH
 */
export function PaymentLinkListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;
  const { t, formatDateTime } = useI18n();

  const [statuses, setStatuses] = useState<PaymentLinkStatus[]>([]);
  const [links, setLinks] = useState<PaymentLinkDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      if (!merchantId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listPaymentLinks(merchantId, {
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setLinks((previous) => (cursor ? [...previous, ...result.paymentLinks] : result.paymentLinks));
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [merchantId, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: PaymentLinkStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>{t("Payment links")}</h1>

      <RequireRole allow={["owner", "finance"]}>
        <p>
          <Link className="dash-button-link" to="/dashboard/payment-links/new">
            {t("New payment link")}
          </Link>
        </p>
      </RequireRole>

      <fieldset className="dash-filters">
        <legend>{t("Status")}</legend>
        {STATUSES.map((status) => (
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
            <th>{t("Reference")}</th>
            <th>{t("Description")}</th>
            <th>{t("Amount")}</th>
            <th>{t("Status")}</th>
            <th>{t("Expires")}</th>
            <th>{t("Paid")}</th>
            <th>{t("Canceled")}</th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.id}>
              <td>
                <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
              </td>
              <td>{dash(link.description)}</td>
              <td>{bhd(link.amountFils)}</td>
              <td>
                <span className={`dash-status dash-status-${link.status}`}>{label(t, link.status)}</span>
              </td>
              <td>{formatDateTime(link.expiresAt)}</td>
              <td>{formatDateTime(link.paidAt)}</td>
              <td>{formatDateTime(link.canceledAt)}</td>
            </tr>
          ))}
          {links.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>{t("No payment links match these filters.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
