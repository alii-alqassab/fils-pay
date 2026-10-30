import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/**
 * `GET /v1/settlement/batches` — `requireMerchantAuth` with no role
 * restriction — a batch list is not as sensitive as the reconciliation
 * report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged — no instant conversion,
 * because there is no timezone in the column to convert against.
 */
/** Filters by batch_date, which is a Bahrain business date. */
export function SettlementBatchListPage() {
  const { t, formatDateTime } = useI18n();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<SettlementBatchStatus[]>([]);
  const [batches, setBatches] = useState<SettlementBatchDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to || undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setBatches((previous) => (cursor ? [...previous, ...result.batches] : result.batches));
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [from, to, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: SettlementBatchStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>{t("Settlement batches")}</h1>

      <fieldset className="dash-filters">
        <legend>{t("Batch date")}</legend>
        <label>
          {t("From")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("To (exclusive)")}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </fieldset>

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
            <th>{t("Batch date")}</th>
            <th>{t("Status")}</th>
            <th>{t("Gross")}</th>
            <th>{t("Fee")}</th>
            <th>{t("Net payout")}</th>
            <th>{t("Closed")}</th>
            <th>{t("Paid")}</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link to={`/dashboard/settlement/${batch.id}`}>{batch.batchDate}</Link>
              </td>
              <td>
                <span className={`dash-status dash-status-${batch.status}`}>{label(t, batch.status)}</span>
              </td>
              <td>{bhd(batch.grossFils)}</td>
              <td>{bhd(batch.feeFils)}</td>
              <td>{bhd(batch.netPayoutFils)}</td>
              <td>{formatDateTime(batch.closedAt)}</td>
              <td>{formatDateTime(batch.paidAt)}</td>
            </tr>
          ))}
          {batches.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>{t("No settlement batches match these filters.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
