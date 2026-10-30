import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSettlementBatch, getSettlementBatchTransactions } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { bhd, dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { SettlementBatchDetailDto, SettlementBatchTransactionDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; batch: SettlementBatchDetailDto };

/**
 * `GET /v1/settlement/batches/:id` plus its line items.
 *
 * The two counts are rendered as two separately-labeled figures and never
 * added, averaged, or presented as one number: a transaction captured twice
 * inside the batch window contributes one scheme export line but two capture
 * events, so they can legitimately differ. Conflating them would invent a
 * discrepancy where there isn't one — or hide a real one.
 *
 * No pagination on the line items: the endpoint has none, and adding a
 * client-side cap would silently drop rows from a settlement figure.
 */
export function SettlementBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, formatDateTime } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lines, setLines] = useState<SettlementBatchTransactionDto[]>([]);

  useEffect(() => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [batch, txns] = await Promise.all([
          getSettlementBatch(id),
          getSettlementBatchTransactions(id),
        ]);
        if (cancelled) return;
        setState({ kind: "loaded", batch });
        setLines(txns.transactions);
      } catch (err) {
        if (cancelled) return;
        // 404, not 403, for another merchant's batch — the same non-disclosure
        // choice the transaction detail read makes.
        if (err instanceof ApiError && err.statusCode === 404) {
          setState({ kind: "not_found" });
        } else {
          setState({ kind: "error", message: describeError(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") return <p>{t("Loading...")}</p>;
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>{t("Settlement batch not found")}</h1>
        <p>
          {t("No settlement batch with this id exists on your account.")}{" "}
          <Link to="/dashboard/settlement">{t("Back to settlement batches")}</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>{t("Settlement batch")}</h1>
        <p className="dash-error">{t(state.message)}</p>
      </section>
    );
  }

  const { batch } = state;

  return (
    <section>
      <h1>{t("Settlement batch")} {batch.batchDate}</h1>
      <p className="dash-muted">
        <code>{batch.id}</code>
      </p>

      <dl className="dash-dl">
        <dt>{t("Status")}</dt>
        <dd>
          <span className={`dash-status dash-status-${batch.status}`}>{label(t, batch.status)}</span>
        </dd>
        <dt>{t("Gross")}</dt>
        <dd>{bhd(batch.grossFils)}</dd>
        <dt>{t("Fee")}</dt>
        <dd>{bhd(batch.feeFils)}</dd>
        <dt>{t("Net payout")}</dt>
        <dd>{bhd(batch.netPayoutFils)}</dd>
        <dt>{t("Closed at")}</dt>
        <dd>{formatDateTime(batch.closedAt)}</dd>
        <dt>{t("Paid at")}</dt>
        <dd>{formatDateTime(batch.paidAt)}</dd>
        <dt>{t("Included transactions")}</dt>
        <dd>{batch.includedTransactionCount}</dd>
        <dt>{t("Capture events in this batch")}</dt>
        <dd>
          {batch.includedEventCount}
          {batch.includedEventCount !== batch.includedTransactionCount ? (
            <span className="dash-muted">
              {" "}
              {t("— more events than transactions is normal: a transaction captured more than once in this window contributes one export line and several events.")}
            </span>
          ) : null}
        </dd>
      </dl>

      <h2>{t("Included transactions")}</h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Line")}</th>
            <th>{t("Transaction")}</th>
            <th>{t("Reference")}</th>
            <th>{t("Status")}</th>
            <th>{t("Authorized")}</th>
            <th>{t("Captured")}</th>
            <th>{t("Scheme amount")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.transactionId}-${line.lineSequence}`}>
              <td>{line.lineSequence}</td>
              <td>
                <Link to={`/dashboard/transactions/${line.transactionId}`}>
                  <code>{line.transactionId}</code>
                </Link>
              </td>
              <td>{dash(line.reference)}</td>
              <td>{label(t, line.status)}</td>
              <td>{bhd(line.authorizedFils)}</td>
              <td>{bhd(line.capturedFils)}</td>
              <td>{bhd(line.schemeAmountFils)}</td>
            </tr>
          ))}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={7}>{t("No scheme export lines in this batch.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="dash-muted">
        {t("The scheme amount is the card-network export figure, quantized to two decimal places at that boundary — it can be up to 9 fils below the captured amount by design.")}
      </p>

      <p>
        <Link to="/dashboard/settlement">{t("Back to settlement batches")}</Link>
      </p>
    </section>
  );
}
