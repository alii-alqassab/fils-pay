import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { RefundDrawer } from "./RefundDrawer.js";
import { bhd, dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import { tk } from "../../i18n/translate.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page — one
 * feature, so one view, not two navigable routes.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
// MK: timeline renders refund events fine
// FH: RefundDrawer import removed 2026-06 until the route exists
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, formatDateTime } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads — the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    const trimmed = captureAmount.trim();
    // The field is whole fils. Reject "1e3", "1.5", "-5", "0x10" etc. up
    // front rather than let Number() quietly coerce them.
    if (trimmed !== "" && (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1)) {
      setActionError(tk("Enter a whole number of fils (1 or more), or leave blank to capture everything outstanding."));
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      // Left blank, `amountFils` is omitted entirely and capture.ts captures
      // everything still outstanding — its own documented default. Computing
      // the remainder here would just be a second, staler copy of that rule.
      const input = trimmed === "" ? {} : { amountFils: Number(trimmed) };
      // A fresh Idempotency-Key per click, including a retry after a decline —
      // same discipline as the checkout page's submit handler.
      await captureTransaction(id, input, crypto.randomUUID());
      setCaptureOpen(false);
      setCaptureAmount("");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id) return;
    if (!window.confirm(t("Void this authorization? The held funds are released and cannot be captured afterwards."))) {
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row —
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return <p>{t("Loading...")}</p>;
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>{t("Transaction not found")}</h1>
        <p>
          {t("No transaction with this id exists on your account.")}{" "}
          <Link to="/dashboard/transactions">{t("Back to transactions")}</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>{t("Transaction")}</h1>
        <p className="dash-error">{t(state.message)}</p>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";

  return (
    <section>
      <h1>{t("Transaction")}</h1>
      <p className="dash-muted">
        <code>{txn.id}</code>
      </p>

      <dl className="dash-dl">
        <dt>{t("Status")}</dt>
        <dd>
          <span className={`dash-status dash-status-${txn.status}`}>{label(t, txn.status)}</span>
        </dd>
        <dt>{t("Authorized amount")}</dt>
        <dd>{bhd(txn.amountFils)}</dd>
        <dt>{t("Captured amount")}</dt>
        <dd>{bhd(txn.capturedFils)}</dd>
        <dt>{t("Currency")}</dt>
        <dd>{txn.currency}</dd>
        <dt>{t("Reference")}</dt>
        <dd>{dash(txn.reference)}</dd>
        <dt>{t("Acquirer reference")}</dt>
        <dd>
          <code>{txn.acquirerReference}</code>
        </dd>
        <dt>{t("Occurred at")}</dt>
        <dd>{formatDateTime(txn.occurredAt)}</dd>
        <dt>{t("Created at")}</dt>
        <dd>{formatDateTime(txn.createdAt)}</dd>
      </dl>

      {/* Capture and void are hidden from `support` as a UX choice — a support
          agent looks things up, they don't move money. Unlike the
          reconciliation page, the API also enforces this server side:
          capture and void require the owner or finance role for sessions. */}
      <RequireRole allow={["owner", "finance"]}>
        {capturable || voidable ? (
          <div className="dash-actions">
            {actionError ? <p className="dash-error">{t(actionError)}</p> : null}

            {capturable ? (
              captureOpen ? (
                <form className="dash-form dash-form-inline" onSubmit={(e) => void handleCapture(e)}>
                  <label>
                    {t("Amount in fils (blank captures everything outstanding)")}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={captureAmount}
                      onChange={(e) => setCaptureAmount(e.target.value)}
                    />
                  </label>
                  <button type="submit" className="dash-button" disabled={submitting}>
                    {submitting ? t("Capturing...") : t("Capture")}
                  </button>
                  <button
                    type="button"
                    className="dash-button"
                    disabled={submitting}
                    onClick={() => setCaptureOpen(false)}
                  >
                    {t("Cancel")}
                  </button>
                </form>
              ) : (
                <button type="button" className="dash-button" onClick={() => setCaptureOpen(true)}>
                  {t("Capture")}
                </button>
              )
            ) : null}

            {voidable ? (
              <button
                type="button"
                className="dash-button"
                disabled={submitting}
                onClick={() => void handleVoid()}
              >
                {t("Void")}
              </button>
            ) : null}
          </div>
        ) : null}
      </RequireRole>

      <RefundDrawer txn={state.txn} onRefunded={load} />

      <h2>{t("Event timeline")}</h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Occurred")}</th>
            <th>{t("Event")}</th>
            <th>{t("Amount")}</th>
            <th>{t("Actor")}</th>
          </tr>
        </thead>
        <tbody>
          {/* Already ordered oldest-first by the endpoint — never re-sorted
              here, so the page can't disagree with the API about history. */}
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatDateTime(event.occurredAt)}</td>
              <td>{event.eventType}</td>
              <td>{event.amountFils === null ? "—" : bhd(event.amountFils)}</td>
              <td>
                {event.actorType}
                {event.actorId ? (
                  <div className="dash-muted">
                    <code>{event.actorId}</code>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {events.length === 0 ? (
            <tr>
              <td colSpan={4}>{t("No events recorded.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <p>
        <Link to="/dashboard/transactions">{t("Back to transactions")}</Link>
      </p>
    </section>
  );
}
