import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash, bahrainDayStartIso } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import { classNames, truncateMiddle } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param — nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 */
// from/to are Asia/Bahrain day starts (the settlement business day), see bahrainDayStartIso
export function TransactionListPage() {
  const { t, formatDateTime } = useI18n();
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box — the checkbox/date controls fire immediately,
  // since those are discrete choices, not a stream of keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: bahrainDayStartIso(from),
          to: bahrainDayStartIso(to),
          search: search || undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setTransactions((previous) =>
          cursor ? [...previous, ...result.transactions] : result.transactions,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [statuses, from, to, search],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: TransactionStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>{t("Transactions")}</h1>

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

      <fieldset className="dash-filters">
        <legend>{t("Filter")}</legend>
        <label>
          {t("From")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {/* Exclusive, because the endpoint's own predicate is
              `occurred_at < to` — labelled rather than quietly shifted by a
              day here, which would make this page and the API disagree about
              what a filter means. */}
          {t("To (exclusive)")}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          {t("Search")}
          <input
            type="search"
            placeholder={t("Reference, acquirer reference, or transaction id")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
      </fieldset>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <p>
        {transactions.length === 1
          ? t("1 transaction loaded")
          : t("{count} transactions loaded", { count: transactions.length })}
      </p>

      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Occurred")}</th>
            <th>{t("Reference")}</th>
            <th>{t("Status")}</th>
            <th>{t("Authorized")}</th>
            <th>{t("Captured")}</th>
            <th>{t("Acquirer reference")}</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => (
            <tr key={txn.id}>
              <td>
                <Link to={`/dashboard/transactions/${txn.id}`}>{formatDateTime(txn.occurredAt)}</Link>
              </td>
              <td>{dash(txn.reference)}</td>
              <td>
                <span className={classNames("dash-status", `dash-status-${txn.status}`)}>{label(t, txn.status)}</span>
              </td>
              <td>{bhd(txn.amountFils)}</td>
              <td>{bhd(txn.capturedFils)}</td>
              <td>
                <code>{truncateMiddle(txn.acquirerReference, 20)}</code>
              </td>
            </tr>
          ))}
          {transactions.length === 0 && !loading ? (
            <tr>
              <td colSpan={6}>{t("No transactions match these filters.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
