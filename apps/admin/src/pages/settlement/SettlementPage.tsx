import { useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import { rebuildAnalytics, rebuildBalances, runBatch } from "../../api/settlement.js";
import { recalculateMdr } from "../../api/mdrRecalculation.js";
import { describeError } from "../../api/client.js";
import { bahrainDate } from "../../dates.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type {
  AnalyticsRebuildSummary,
  BalanceRebuildSummary,
  MdrRecalcSummary,
  RunBatchSummary,
} from "../../types.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

// Yesterday's Asia/Bahrain business date, regardless of the browser's timezone.
function yesterdayIso(): string {
  return bahrainDate(-1);
}

/**
 * The two cross-process operations. Both are `finance` /
 * `super_admin` server-side; both write their audit row *before* the call
 * crosses the network, so an attempt is on record even if the settlement
 * service never answers.
 *
 * The analytics rebuild at the bottom is the same role gate and the same
 * confirm-before-you-run shape, but it never leaves apps/api — it is one
 * transaction of SQL, so its audit row is simply part of that transaction.
 */
export function SettlementPage() {
  const { t } = useI18n();
  const [date, setDate] = useState(yesterdayIso());
  const [merchantId, setMerchantId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunBatchSummary | null>(null);

  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<BalanceRebuildSummary | null>(null);

  const [confirmingAnalytics, setConfirmingAnalytics] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsRebuildSummary | null>(null);

  const [mdrMerchantId, setMdrMerchantId] = useState("");
  const [mdrFrom, setMdrFrom] = useState("");
  const [mdrTo, setMdrTo] = useState("");
  const [mdrBusy, setMdrBusy] = useState(false);
  const [mdrError, setMdrError] = useState<string | null>(null);
  const [mdrResult, setMdrResult] = useState<MdrRecalcSummary | null>(null);

  /** Idempotent per business date: re-running returns the already-closed batches. */
  async function handleRunBatch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(
        await runBatch({ date, merchantId: merchantId.trim() ? merchantId.trim() : undefined }),
      );
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setRunBusy(false);
    }
  }

  // after clicking rebuild on staging alpha's balance jumped to like 3x?? — am
  // MK: staging data is junk. cache-only, safe to click
  async function handleRebuild(): Promise<void> {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildResult(null);
    try {
      setRebuildResult(await rebuildBalances());
      setConfirmingRebuild(false);
    } catch (err) {
      setRebuildError(describeError(err));
    } finally {
      setRebuildBusy(false);
    }
  }

  async function handleRebuildAnalytics(): Promise<void> {
    setAnalyticsBusy(true);
    setAnalyticsError(null);
    setAnalyticsResult(null);
    try {
      setAnalyticsResult(await rebuildAnalytics());
      setConfirmingAnalytics(false);
    } catch (err) {
      setAnalyticsError(describeError(err));
    } finally {
      setAnalyticsBusy(false);
    }
  }

  // FH: ADMIN.md says this is safe
  async function handleRecalculateMdr(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setMdrBusy(true);
    setMdrError(null);
    setMdrResult(null);
    try {
      setMdrResult(await recalculateMdr(mdrMerchantId.trim(), { from: mdrFrom, to: mdrTo }));
    } catch (err) {
      setMdrError(describeError(err));
    } finally {
      setMdrBusy(false);
    }
  }

  const runResults = runResult?.merchantResults ?? [];
  const mdrAdjusted = mdrResult?.adjusted ?? [];

  return (
    <section>
      <h1>{t("Settlement ops")}</h1>
      <p className="admin-muted">
        {t("Every action below is money-adjacent and is gated server-side to the finance and super admin roles. Every invocation is written to the admin audit log before it runs.")}
      </p>

      <h2>{t("Re-run a daily batch")}</h2>
      <p className="admin-muted">
        {t("Closes and pays out the batch for one business date. Running a date that is already closed or paid is safe — the settlement service reports it as already-done rather than doing it twice.")}
      </p>

      {runError ? <p className="admin-error">{t(runError)}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role cannot trigger settlement runs. Ask a finance admin.")}
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleRunBatch(e)}>
          <label>
            {t("Business date")}
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            {t("Merchant id (optional — leave blank to run every eligible merchant)")}
            <input
              type="text"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            />
          </label>
          <button type="submit" disabled={runBusy}>
            {runBusy ? t("Running...") : t("Run batch")}
          </button>
        </form>
      </RequireRole>

      {runResult ? (
        <div className="admin-notice">
          <p>
            {t("Batch run for")} <strong>{runResult.businessDate}</strong> — {t("Merchants processed: {count}.", { count: runResults.length })}
          </p>
          {runResults.length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Merchant")}</th>
                  <th>{t("Batch")}</th>
                  <th>{t("Gross")}</th>
                  <th>{t("Fee")}</th>
                  <th>{t("Net payout")}</th>
                  <th>{t("Already closed")}</th>
                  <th>{t("Already paid")}</th>
                </tr>
              </thead>
              <tbody>
                {runResults.map((outcome) => (
                  <tr key={`${outcome.merchantId}-${outcome.batchId}`}>
                    <td>
                      <code>{outcome.merchantId}</code>
                    </td>
                    <td>
                      <code>{outcome.batchId}</code>
                    </td>
                    <td>{bhd(outcome.grossFils)}</td>
                    <td>{bhd(outcome.feeFils)}</td>
                    <td>{bhd(outcome.netPayoutFils)}</td>
                    <td>{outcome.alreadyClosed ? t("yes") : t("no")}</td>
                    <td>{outcome.alreadyPaid ? t("yes") : t("no")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <h2>{t("Rebuild cached balances")}</h2>
      <p className="admin-muted">
        {t("Recomputes every merchant's cached payable balance from the ledger, the authoritative record. The ledger itself is only read, never written — but this touches every merchant on the platform at once, so it asks before it runs.")}
      </p>

      {rebuildError ? <p className="admin-error">{t(rebuildError)}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">{t("Your role cannot rebuild balances. Ask a finance admin.")}</p>
        }
      >
        {confirmingRebuild ? (
          <div className="admin-confirm">
            <p>
              <strong>{t("Rebuild balances for every merchant?")}</strong>{" "}
              {t("This recalculates all cached payable balances and records the action in the admin audit log.")}
            </p>
            <button type="button" disabled={rebuildBusy} onClick={() => void handleRebuild()}>
              {rebuildBusy ? t("Rebuilding...") : t("Yes, rebuild all balances")}
            </button>{" "}
            <button type="button" disabled={rebuildBusy} onClick={() => setConfirmingRebuild(false)}>
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingRebuild(true)}>
            {t("Rebuild balances")}
          </button>
        )}
      </RequireRole>

      {rebuildResult ? (
        <div className="admin-notice">
          <p>
            {t("Balances rebuilt: {rebuilt}. Changed: {changed}.", {
              rebuilt: rebuildResult.rebuiltCount,
              changed: (rebuildResult.changed ?? []).length,
            })}
          </p>
          {(rebuildResult.changed ?? []).length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Merchant")}</th>
                  <th>{t("Before")}</th>
                  <th>{t("After")}</th>
                </tr>
              </thead>
              <tbody>
                {(rebuildResult.changed ?? []).map((change) => (
                  <tr key={change.merchantId}>
                    <td>
                      <code>{change.merchantId}</code>
                    </td>
                    <td>{bhd(change.before)}</td>
                    <td>{bhd(change.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="admin-muted">{t("Every cached balance already matched the ledger.")}</p>
          )}
        </div>
      ) : null}

      <h2>{t("Rebuild analytics")}</h2>
      <p className="admin-muted">
        {t("Recomputes the analytics read model — daily volumes and payout trends — from scratch, for when a merchant reports their dashboard looking behind and you would rather not wait for the reporting worker to catch up. Like the balance rebuild above, it touches every merchant at once, so it asks before it runs.")}
      </p>

      {analyticsError ? <p className="admin-error">{t(analyticsError)}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">{t("Your role cannot rebuild analytics. Ask a finance admin.")}</p>
        }
      >
        {confirmingAnalytics ? (
          <div className="admin-confirm">
            <p>
              <strong>{t("Rebuild analytics for every merchant?")}</strong>{" "}
              {t("This replaces both rollup tables with a fresh recompute and records the action in the admin audit log.")}
            </p>
            <button
              type="button"
              disabled={analyticsBusy}
              onClick={() => void handleRebuildAnalytics()}
            >
              {analyticsBusy ? t("Rebuilding...") : t("Yes, rebuild analytics")}
            </button>{" "}
            <button
              type="button"
              disabled={analyticsBusy}
              onClick={() => setConfirmingAnalytics(false)}
            >
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingAnalytics(true)}>
            {t("Rebuild analytics")}
          </button>
        )}
      </RequireRole>

      {analyticsResult ? (
        <div className="admin-notice">
          <p>
            {t("Daily-volume rows rebuilt: {volume}. Payout-trend rows rebuilt: {trend}.", {
              volume: analyticsResult.volumeRows,
              trend: analyticsResult.trendRows,
            })}
          </p>
        </div>
      ) : null}

      <h2>{t("Recalculate MDR")}</h2>
      <p className="admin-muted">
        {t("Re-derives one merchant's settlement-batch fees over a date range at their current contracted rate, and posts a ledger adjustment for any difference. Finance runs this after a rate change lands so historical batches reflect the same figure a fresh reconciliation would show.")}
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role cannot run an MDR recalculation. Ask a finance admin.")}
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleRecalculateMdr(e)}>
          <label>
            {t("Merchant id")}
            <input
              value={mdrMerchantId}
              onChange={(e) => setMdrMerchantId(e.target.value)}
              placeholder={t("merchant UUID")}
              required
            />
          </label>
          <label>
            {t("From (inclusive)")}
            <input type="date" value={mdrFrom} onChange={(e) => setMdrFrom(e.target.value)} required />
          </label>
          <label>
            {t("To (exclusive)")}
            <input type="date" value={mdrTo} onChange={(e) => setMdrTo(e.target.value)} required />
          </label>
          <button type="submit" disabled={mdrBusy}>
            {mdrBusy ? t("Recalculating…") : t("Recalculate MDR")}
          </button>
        </form>
      </RequireRole>

      {mdrError ? <p className="admin-error">{t(mdrError)}</p> : null}

      {mdrResult ? (
        <div>
          <p>
            {t("Considered {considered} batch(es); {changed} had a fee change.", {
              considered: mdrResult.batchesConsidered,
              changed: mdrAdjusted.length,
            })}
          </p>
          {mdrAdjusted.length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Batch date")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Old fee")}</th>
                  <th>{t("New fee")}</th>
                  <th>{t("Difference")}</th>
                </tr>
              </thead>
              <tbody>
                {mdrAdjusted.map((adjustment) => (
                  <tr key={adjustment.batchId}>
                    <td>{adjustment.batchDate}</td>
                    <td>{label(t, adjustment.status)}</td>
                    <td>{bhd(adjustment.oldFeeFils)}</td>
                    <td>{bhd(adjustment.newFeeFils)}</td>
                    <td>{bhd(adjustment.diffFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="admin-muted">{t("Every batch in range already matched the current rate.")}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
