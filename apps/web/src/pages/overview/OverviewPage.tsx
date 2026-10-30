import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPayoutTrends, getTopLinks, getVolumes } from "../../api/analytics.js";
import { describeError } from "../../api/client.js";
import { StalenessBadge } from "../../components/StalenessBadge.js";
import { CompanyIdCard } from "../../components/CompanyIdCard.js";
import { bhd, dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import { formatCount } from "../../utils/helpers.js";
import type { PayoutTrendsResponse, TopLinksResponse, VolumesResponse } from "../../types.js";

/** 60s: comfortably above the reporting worker's 15s worst-case lag, and
 *  more than often enough for a dashboard. Poll, not push —
 *  there is no websocket or SSE anywhere in this platform, and this page does
 *  not introduce the first one. */
const POLL_MS = 60_000;

export function OverviewPage() {
  const { t, formatDateTime } = useI18n();
  // Left blank, the server applies its own "last 30 Asia/Bahrain days"
  // default — the client does not compute a competing one.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [topLinksLimit, setTopLinksLimit] = useState(10);

  const [volumes, setVolumes] = useState<VolumesResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutTrendsResponse | null>(null);
  const [topLinks, setTopLinks] = useState<TopLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the server's own clamp so this page never displays a limit the
  // server would have silently overridden.
  const clampedLimit = Math.min(50, Math.max(1, Math.trunc(topLinksLimit) || 10));

  const load = useCallback(async () => {
    const range = { from: from || undefined, to: to || undefined };
    setLoading(true);
    setError(null);
    try {
      // Three independent endpoints, three independent fetches — there is no
      // combined route to call.
      const [v, p, t] = await Promise.all([
        getVolumes(range),
        getPayoutTrends(range),
        getTopLinks({ ...range, limit: clampedLimit }),
      ]);
      setVolumes(v);
      setPayouts(p);
      setTopLinks(t);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, clampedLimit]);

  // overview memory leak (heap +40mb/hr), pretty sure its these effects — am
  // FH: profiled for 1h, heap flat. maybe it was a browser extension? open
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const peakGross = Math.max(1, ...(volumes?.points.map((point) => point.capturedGrossFils) ?? [1]));

  return (
    <section>
      <h1>{t("Overview")}</h1>
      <CompanyIdCard />

      <form
        className="dash-form dash-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          {t("From")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("To (exclusive)")}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          {t("Top links")}
          <input
            type="number"
            min={1}
            max={50}
            value={topLinksLimit}
            onChange={(e) => setTopLinksLimit(Number(e.target.value))}
          />
        </label>
        <button type="submit" className="dash-button" disabled={loading}>
          {loading ? t("Refreshing...") : t("Refresh")}
        </button>
      </form>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <h2>
        {t("Captured volume")}{" "}
        {volumes ? <StalenessBadge readModelAsOf={volumes.readModelAsOf} live={volumes.live} /> : null}
      </h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Date")}</th>
            <th>{t("Captured")}</th>
            <th>{t("Gross")}</th>
            <th>{t("Voided")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {volumes?.points.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{formatCount(point.capturedCount)}</td>
              <td>{bhd(point.capturedGrossFils)}</td>
              <td>{formatCount(point.voidedCount)}</td>
              <td className="dash-bar-cell">
                {/* A plain CSS bar, scaled to the window's own peak — no
                    charting library, no new dependency. */}
                <span
                  className="dash-bar"
                  style={{ width: `${(point.capturedGrossFils / peakGross) * 100}%` }}
                />
              </td>
            </tr>
          ))}
          {volumes && volumes.points.length === 0 ? (
            <tr>
              <td colSpan={5}>{t("No captured volume in this window.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>
        {t("Payout trends")}{" "}
        {payouts ? <StalenessBadge readModelAsOf={payouts.readModelAsOf} live={payouts.live} /> : null}
      </h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>{t("Batch date")}</th>
            <th>{t("Status")}</th>
            <th>{t("Gross")}</th>
            <th>{t("Fee")}</th>
            <th>{t("Net payout")}</th>
            <th>{t("Paid")}</th>
          </tr>
        </thead>
        <tbody>
          {payouts?.points.map((point) => (
            <tr key={point.settlementBatchId}>
              <td>
                <Link to={`/dashboard/settlement/${point.settlementBatchId}`}>{point.batchDate}</Link>
              </td>
              <td>{label(t, point.status)}</td>
              <td>{bhd(point.grossFils)}</td>
              <td>{bhd(point.feeFils)}</td>
              <td>{bhd(point.netPayoutFils)}</td>
              <td>{formatDateTime(point.paidAt)}</td>
            </tr>
          ))}
          {payouts && payouts.points.length === 0 ? (
            <tr>
              <td colSpan={6}>{t("No settled batches in this window.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>
        {t("Top paid links")}{" "}
        {topLinks ? (
          <StalenessBadge readModelAsOf={topLinks.readModelAsOf} live={topLinks.live} />
        ) : null}
      </h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("Reference")}</th>
            <th>{t("Description")}</th>
            <th>{t("Amount")}</th>
            <th>{t("Paid at")}</th>
          </tr>
        </thead>
        <tbody>
          {topLinks?.links.map((link, index) => (
            <tr key={link.id}>
              <td>{index + 1}</td>
              <td>
                <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
              </td>
              <td>{dash(link.description)}</td>
              <td>{bhd(link.amountFils)}</td>
              <td>{formatDateTime(link.paidAt)}</td>
            </tr>
          ))}
          {topLinks && topLinks.links.length === 0 ? (
            <tr>
              <td colSpan={5}>{t("No paid payment links in this window.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
