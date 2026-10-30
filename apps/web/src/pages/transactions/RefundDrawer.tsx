import { useEffect, useRef, useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { request, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { DuckDashGame } from "../../components/DuckDashGame.js";
import { bhd } from "../../format.js";
import { newIdempotencyKey } from "../../utils/cardValidation.js";
import type { TransactionDto } from "../../types.js";

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE = new Set(["captured", "partially_captured", "partially_refunded"]);

/** How long the "processing" screen stays up, whatever the bank answers: refunds take a moment to settle. */
export const REFUND_WAIT_MS = 120_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function refundErrorText(err: unknown): string {
  const text = describeError(err);
  return /refunds_on_hold/.test(text) ? "Refunds are on hold for your business. Please contact support." : text;
}

/**
 * Refund button for a captured payment. Blank amount refunds everything still
 * refundable; otherwise the merchant types a BHD amount. The server checks the
 * amount against what is left, so a mistake is refused, not applied.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waitEndsAt, setWaitEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  // One key per attempt: a retry after a dropped connection must not refund twice.
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);

  // Tick once a second while the processing screen is up, for the countdown and its progress bar.
  useEffect(() => {
    if (waitEndsAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [waitEndsAt]);

  const merchantId = me?.merchant.id;
  if (!doneMessage && (!REFUNDABLE.has(txn.status) || txn.capturedFils <= 0)) return null;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;
    setError(null);

    const trimmed = amount.trim();
    let amountFils: number | undefined;
    if (trimmed !== "") {
      try {
        amountFils = Number(parseBhdToFils(trimmed));
      } catch {
        setError("Enter the amount as BHD, for example 4.750, or leave it blank to refund everything left.");
        return;
      }
      if (!Number.isSafeInteger(amountFils) || amountFils <= 0) {
        setError("The refund amount must be more than zero.");
        return;
      }
      if (amountFils > txn.capturedFils) {
        setError(`You can refund at most ${bhd(txn.capturedFils)} on this payment.`);
        return;
      }
    }
    const what = amountFils === undefined ? "everything still refundable" : bhd(amountFils);
    if (!window.confirm(`Refund ${what}? The money goes back to the cardholder and cannot be recalled.`)) return;

    const fingerprint = String(amountFils ?? "all");
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }

    setSubmitting(true);
    const startedAt = Date.now();
    try {
      const response = request(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": attempt.current.key },
        body: JSON.stringify(amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils }),
      });
      // The request goes out at once (and is safe to retry: same key). A refusal (a 4xx) is shown
      // immediately; only an accepted refund keeps the customer on the processing screen.
      await response;
      attempt.current = null;
      setWaitEndsAt(startedAt + REFUND_WAIT_MS);
      setNow(Date.now());
      setPlaying(true);
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, startedAt + REFUND_WAIT_MS - Date.now())));
      setOpen(false);
      setAmount("");
      setDoneMessage(`Refund of ${what} completed.`);
      // Refetch: the refund added an event to the timeline and changed the status.
      await onRefunded();
    } catch (err) {
      // A definite answer (4xx) ends the attempt; a network/5xx error keeps the key for the retry.
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500) attempt.current = null;
      setError(refundErrorText(err));
    } finally {
      setWaitEndsAt(null);
      setPlaying(false);
      setSubmitting(false);
    }
  }

  const remaining = waitEndsAt === null ? 0 : Math.max(0, waitEndsAt - now);
  const progress = waitEndsAt === null ? 0 : Math.min(100, ((REFUND_WAIT_MS - remaining) / REFUND_WAIT_MS) * 100);

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {doneMessage ? (
          <p className="dash-success" role="status">
            {doneMessage}{" "}
            <button type="button" className="dash-button" onClick={() => setDoneMessage(null)}>OK</button>
          </p>
        ) : null}
        {error ? <p className="dash-error" role="alert">{error}</p> : null}

        {waitEndsAt !== null ? (
          <div className="refund-wait-center">
            <div className="refund-wait" role="status">
              <strong className="refund-wait-title">Processing your refund…</strong>
              <span className="refund-wait-sub">Please keep this page open. About <b>{clock(remaining)}</b> left.</span>
              <div className="refund-wait-bar" aria-hidden="true"><div style={{ width: `${progress}%` }} /></div>
              <span className="refund-wait-sub">While you wait, here is a little game:</span>
              <DuckDashGame />
            </div>
          </div>
        ) : open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BHD (blank refunds everything still refundable)
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={submitting}
              />
            </label>
            <p className="dash-muted">Captured so far: {bhd(txn.capturedFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Sending…" : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="dash-button" onClick={() => setPlaying((p) => !p)}>
              {playing ? "Hide game" : "Play while you wait"}
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
        {waitEndsAt === null && open && playing ? <DuckDashGame /> : null}
      </div>
    </RequireRole>
  );
}
