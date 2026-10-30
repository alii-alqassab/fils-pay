import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { getMerchant, listMerchantKycDocuments, recomputeTransactionStatuses, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { API_BASE_URL, describeError, WEB_BASE_URL } from "../../api/client.js";
import { bahrainDate } from "../../dates.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { AdminMerchantDetail, CreditReasonCode, KycDocumentSummary, RotatedApiKey } from "../../types.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

// Today's Asia/Bahrain business date, regardless of the browser's timezone.
function todayIso(): string {
  return bahrainDate(0);
}

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { admin, rememberImpersonation } = useAdminAuth();
  const { t, formatDate, formatDateTime } = useI18n();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [kycDocuments, setKycDocuments] = useState<KycDocumentSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kycNotes, setKycNotes] = useState("");
  const [busy, setBusy] = useState(false);

  /** Which key the operator has asked to rotate and not yet confirmed. */
  const [pendingRotation, setPendingRotation] = useState<string | null>(null);
  const [rotationLabel, setRotationLabel] = useState("");
  /** Shown exactly once: `rawKey` exists in the rotate response and nowhere else. */
  const [rotatedKey, setRotatedKey] = useState<RotatedApiKey | null>(null);

  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  const [creditAmountBhd, setCreditAmountBhd] = useState("");
  const [creditReason, setCreditReason] = useState<CreditReasonCode>("goodwill");
  const [creditMemo, setCreditMemo] = useState("");
  const [creditReverseFee, setCreditReverseFee] = useState(false);
  const [creditEffectiveDate, setCreditEffectiveDate] = useState(todayIso());

  const [adjustDeltaFils, setAdjustDeltaFils] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
      if (admin?.role === "finance" || admin?.role === "super_admin" || admin?.role === "master") {
        setKycDocuments(await listMerchantKycDocuments(id));
      }
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id, admin?.role]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected"): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await submitKycReview(id, {
        outcome,
        notes: kycNotes.trim() ? kycNotes.trim() : undefined,
      });
      setNotice(
        t("KYC {outcome}. Onboarding status is now {status} (KYC passed: {passed}).", {
          outcome: label(t, outcome),
          status: label(t, result.onboardingStatus),
          passed: result.kycPassed ? t("yes") : t("no"),
        }),
      );
      setKycNotes("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** The old key keeps working for a 24h overlap window, then stops. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // FH: this ends up in adjustMerchantBalanceCache (cache only)
  // MK: it's the journaled one since Sep
  async function handleAdjustBalance(): Promise<void> {
    if (!id) return;
    const deltaText = adjustDeltaFils.trim();
    // Digits only (optional leading minus): Number() alone would accept
    // "1e3", "0x10" or " " and turn them into a ledger amount.
    const deltaFils = /^-?\d+$/.test(deltaText) ? Number(deltaText) : Number.NaN;
    if (!Number.isSafeInteger(deltaFils) || deltaFils === 0) {
      setActionError(t("Enter a non-zero whole number of fils."));
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await adjustBalance(id, { deltaFils, reason: adjustReason.trim() });
      setNotice(
        t("Balance adjusted by {delta}: {before} → {after}.", {
          delta: bhd(result.deltaFils),
          before: bhd(result.cachedPayableFilsBefore),
          after: bhd(result.cachedPayableFilsAfter),
        }),
      );
      setAdjustDeltaFils("");
      setAdjustReason("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueCredit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // BD in, integer fils out, via the platform's own string-based parser —
      // never parseFloat, which cannot represent the third decimal exactly.
      const baseAmountFils = parseBhdToFils(creditAmountBhd.trim());
      const record = await issueCredit(id, {
        baseAmountFils,
        reasonCode: creditReason,
        effectiveDate: creditEffectiveDate,
        reverseFee: creditReverseFee,
        memo: creditMemo.trim() ? creditMemo.trim() : undefined,
      });
      setNotice(
        record.status === "posted"
          ? t("Credit of {amount} posted to the ledger (entry group {group}).", {
              amount: bhd(record.postedAmountFils),
              group: record.ledgerEntryGroupId ?? t("unknown"),
            })
          : t("Credit of {amount} raised and awaiting a second approver — see Credits.", {
              amount: bhd(record.postedAmountFils),
            }),
      );
      setCreditAmountBhd("");
      setCreditMemo("");
      setCreditReverseFee(false);
      await load();
    } catch (err) {
      setActionError(err instanceof RangeError ? err.message : describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await recomputeTransactionStatuses(id);
      setNotice(
        t("Transactions scanned: {scanned}. Statuses updated: {updated}.", {
          scanned: result.scanned,
          updated: result.updated,
        }),
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const grant = await startImpersonation(id);
      rememberImpersonation({ ...grant, merchantDisplayName: detail.merchant.displayName });
      // The grant rides an httpOnly cookie set for apps/api's domain, which
      // apps/web already sends with `credentials: 'include'` — so the
      // merchant dashboard just works, unaware of how it was authenticated.
      // Opened in a second tab on purpose: this tab keeps showing the
      // impersonation banner and its exit action, which is the whole point
      // of the banner existing.
      const opened = window.open(WEB_BASE_URL, "_blank", "noopener");
      if (!opened) setImpersonationUrl(WEB_BASE_URL);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section>
        <p className="admin-error">{t(loadError)}</p>
        <Link to="/merchants">{t("Back to merchants")}</Link>
      </section>
    );
  }

  if (!detail) {
    return <p>{t("Loading merchant...")}</p>;
  }

  const { merchant } = detail;
  const profile = detail.businessProfile;
  const apiKeys = detail.apiKeys ?? [];
  const webhookEndpoints = detail.webhookEndpoints ?? [];
  const kycReviews = detail.kycReviews ?? [];
  const batches = detail.recentSettlementBatches ?? [];

  return (
    <section>
      <p>
        <Link to="/merchants">{t("← Merchants")}</Link>
      </p>
      <h1>{merchant.displayName}</h1>
      <p className="admin-muted">
        <code>{merchant.id}</code>
      </p>

      {actionError ? <p className="admin-error">{t(actionError)}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      <h2>{t("Profile")}</h2>
      <dl className="admin-dl">
        <dt>{t("Status")}</dt>
        <dd>{label(t, merchant.status)}</dd>
        <dt>{t("Onboarding status")}</dt>
        <dd>{label(t, merchant.onboardingStatus)}</dd>
        <dt>{t("KYC")}</dt>
        <dd>{merchant.kycPassed ? t("passed") : t("not passed")}</dd>
        <dt>{t("MDR")}</dt>
        <dd>
          {(merchant.mdrBps / 100).toFixed(2)}% ({merchant.mdrBps} bps)
        </dd>
        <dt>{t("Current negotiated rate")}</dt>
        <dd>
          {detail.currentFeeSchedule
            ? t("{rate}% ({bps} bps), effective {date}", {
                rate: (detail.currentFeeSchedule.mdrBps / 100).toFixed(2),
                bps: detail.currentFeeSchedule.mdrBps,
                date: formatDate(detail.currentFeeSchedule.effectiveFrom),
              })
            : t("no negotiated schedule on file (uses MDR above)")}
        </dd>
        <dt>{t("Mode")}</dt>
        <dd>{merchant.testMode ? t("test") : t("live")}</dd>
        <dt>{t("Created")}</dt>
        <dd>{formatDateTime(merchant.createdAt)}</dd>
        {profile ? (
          <>
            <dt>{t("Legal name")}</dt>
            <dd>{profile.legalName}</dd>
            <dt>{t("Registration number")}</dt>
            <dd>{profile.registrationNumber}</dd>
            <dt>{t("Business type")}</dt>
            <dd>{profile.businessType}</dd>
            <dt>{t("Contact")}</dt>
            <dd>
              <bdi>{profile.contactEmail}</bdi> / <bdi>{profile.contactPhone}</bdi>
            </dd>
            <dt>{t("Address")}</dt>
            <dd>
              {profile.addressLine1}
              {profile.addressLine2 ? `, ${profile.addressLine2}` : ""}, {profile.city}
              {profile.postalCode ? ` ${profile.postalCode}` : ""}, {profile.country}
            </dd>
          </>
        ) : null}
      </dl>
      {!profile ? <p className="admin-muted">{t("No business profile submitted yet.")}</p> : null}

      <h2>{t("Balance")}</h2>
      {detail.balance ? (
        <p>
          {t("Cached payable:")} <strong>{bhd(detail.balance.cachedPayableFils)}</strong> ({t("updated")}{" "}
          {formatDateTime(detail.balance.updatedAt)}). {t("The ledger remains authoritative; this figure is a cache, rebuildable from Settlement ops.")}
        </p>
      ) : (
        <p className="admin-muted">{t("No cached balance row yet.")}</p>
      )}

      <h2>{t("Adjust balance")}</h2>
      <p className="admin-muted">
        {t("A direct correction to this merchant's cached payable balance, for when support has confirmed the figure on screen is wrong and it needs to be right now rather than after the next settlement cycle. Requires the finance or super admin role.")}
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role is read-only for balance corrections. Ask a finance admin.")}
          </p>
        }
      >
        <div className="admin-form">
          <label>
            {t("Delta (fils, may be negative)")}
            <input
              value={adjustDeltaFils}
              onChange={(e) => setAdjustDeltaFils(e.target.value)}
              inputMode="numeric"
              placeholder="50000"
            />
          </label>
          <label>
            {t("Reason")}
            <input
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              placeholder={t("phone confirmation with merchant")}
            />
          </label>
          <div>
            <button
              type="button"
              disabled={busy || !adjustDeltaFils.trim() || !adjustReason.trim()}
              onClick={() => void handleAdjustBalance()}
            >
              {t("Adjust balance")}
            </button>
          </div>
        </div>
      </RequireRole>

      <h2>{t("Issue credit")}</h2>
      <p className="admin-muted">
        {t("Journals a manual credit to this merchant's payable balance. Above the approval limit it waits in Credits for a second finance operator; at or below it, it posts immediately. The effective date is the accounting date the ledger legs are booked against.")}{" "}
        <Link to="/credits">{t("Credits")}</Link>
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role cannot issue credits. Ask a finance admin.")}
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleIssueCredit(e)}>
          <label>
            {t("Amount (BD, up to 3 decimals)")}
            <input
              type="text"
              required
              placeholder="50.000"
              value={creditAmountBhd}
              onChange={(e) => setCreditAmountBhd(e.target.value)}
            />
          </label>
          <label>
            {t("Reason")}
            <select
              value={creditReason}
              onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
            >
              <option value="goodwill">{t("Goodwill")}</option>
              <option value="dispute_resolution">{t("Dispute resolution")}</option>
              <option value="correction">{t("Correction")}</option>
            </select>
          </label>
          <label>
            {t("Effective date")}
            <input
              type="date"
              required
              value={creditEffectiveDate}
              onChange={(e) => setCreditEffectiveDate(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={creditReverseFee}
              onChange={(e) => setCreditReverseFee(e.target.checked)}
            />{" "}
            {t("Also reverse the MDR on this amount ({rate}%)", { rate: (merchant.mdrBps / 100).toFixed(2) })}
          </label>
          <label>
            {t("Memo (optional)")}
            <textarea value={creditMemo} onChange={(e) => setCreditMemo(e.target.value)} rows={2} />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? t("Submitting...") : t("Issue credit")}
          </button>
        </form>
      </RequireRole>

      <h2>{t("KYC review")}</h2>
      <RequireRole allow={["finance", "super_admin"]}>
        <h3>{t("Uploaded documents")}</h3>
        {kycDocuments.length === 0 ? <p className="admin-muted">{t("No documents uploaded yet.")}</p> : (
          <ul>{kycDocuments.map((document) => (
            <li key={document.id}>
              {document.documentType}: {document.fileName}{" · "}
              <a href={`${API_BASE_URL}/v1/admin/merchants/${encodeURIComponent(id ?? "")}/kyc/documents/${encodeURIComponent(document.id)}/file`} target="_blank" rel="noreferrer">{t("View document")}</a>
            </li>
          ))}</ul>
        )}
      </RequireRole>
      <p className="admin-muted">
        {t("Approving or rejecting requires the finance or super admin role; the API enforces it and answers 403 otherwise.")}
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role is read-only for KYC decisions. Ask a finance admin to review.")}
          </p>
        }
      >
        <div className="admin-form">
          <label>
            {t("Notes (optional)")}
            <textarea value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} rows={3} />
          </label>
          <div>
            <button type="button" disabled={busy} onClick={() => void handleKycReview("approved")}>
              {t("Approve KYC")}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => void handleKycReview("rejected")}>
              {t("Reject KYC")}
            </button>
          </div>
        </div>
      </RequireRole>

      <h3>{t("Review history")}</h3>
      {kycReviews.length === 0 ? (
        <p className="admin-muted">{t("No reviews recorded.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Outcome")}</th>
              <th>{t("Reviewer")}</th>
              <th>{t("Notes")}</th>
              <th>{t("Reviewed at")}</th>
            </tr>
          </thead>
          <tbody>
            {kycReviews.map((review) => (
              <tr key={review.id}>
                <td>{label(t, review.outcome)}</td>
                <td>{review.reviewerIdentifier}</td>
                <td>{review.notes ?? "-"}</td>
                <td>{formatDateTime(review.reviewedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t("API keys")}</h2>
      {rotatedKey ? (
        <div className="admin-notice">
          <p>
            <strong>{t("New key issued — copy it now.")}</strong>{" "}
            {t("This value is shown once and is not recoverable afterwards.")}
          </p>
          <p>
            <code>{rotatedKey.rawKey}</code>
          </p>
          <p className="admin-muted">
            {t("New key id")} <code>{rotatedKey.id}</code>, {t("replacing previous key")}{" "}
            <code>{rotatedKey.previousKeyId}</code>.
          </p>
          <button type="button" onClick={() => setRotatedKey(null)}>
            {t("Dismiss")}
          </button>
        </div>
      ) : null}

      {apiKeys.length === 0 ? (
        <p className="admin-muted">{t("No API keys.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Prefix")}</th>
              <th>{t("Label")}</th>
              <th>{t("Created")}</th>
              <th>{t("Last used")}</th>
              <th>{t("Revoked")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((key) => (
              <tr key={key.id}>
                <td>
                  <code>{key.prefix}</code>
                </td>
                <td>{key.label ?? "-"}</td>
                <td>{formatDate(key.createdAt)}</td>
                <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t("never")}</td>
                <td>{key.revokedAt ? formatDateTime(key.revokedAt) : "-"}</td>
                <td>
                  {key.revokedAt ? null : (
                    <RequireRole
                      allow={["finance", "super_admin"]}
                      fallback={<span className="admin-muted">{t("finance role required")}</span>}
                    >
                      <button type="button" onClick={() => setPendingRotation(key.id)}>
                        {t("Rotate")}
                      </button>
                    </RequireRole>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingRotation ? (
        <div className="admin-confirm">
          <p>
            <strong>{t("Rotate this API key?")}</strong>{" "}
            {t("The current key is revoked and a replacement is issued in the same transaction, so the merchant is never left without a working key — but any integration still sending the old key will start failing immediately.")}
          </p>
          <label>
            {t("Label for the new key (optional)")}
            <input
              type="text"
              value={rotationLabel}
              onChange={(e) => setRotationLabel(e.target.value)}
            />
          </label>
          <button type="button" disabled={busy} onClick={() => void handleRotate(pendingRotation)}>
            {busy ? t("Rotating...") : t("Yes, rotate it")}
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setPendingRotation(null);
              setRotationLabel("");
            }}
          >
            {t("Cancel")}
          </button>
        </div>
      ) : null}

      <h2>{t("Webhook endpoints")}</h2>
      {webhookEndpoints.length === 0 ? (
        <p className="admin-muted">{t("No endpoints registered.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("URL")}</th>
              <th>{t("Status")}</th>
              <th>{t("Secret prefix")}</th>
              <th>{t("Created")}</th>
            </tr>
          </thead>
          <tbody>
            {webhookEndpoints.map((endpoint) => (
              <tr key={endpoint.id}>
                <td dir="ltr">{endpoint.url}</td>
                <td>{label(t, endpoint.status)}</td>
                <td>
                  <code>{endpoint.secretPrefix}</code>
                </td>
                <td>{formatDate(endpoint.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link to={`/webhooks/${merchant.id}`}>{t("Replay a batch of deliveries for this merchant")}</Link>
      </p>

      <h2>{t("Recent settlement batches")}</h2>
      {batches.length === 0 ? (
        <p className="admin-muted">{t("No batches yet.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Date")}</th>
              <th>{t("Status")}</th>
              <th>{t("Gross")}</th>
              <th>{t("Fee")}</th>
              <th>{t("Net payout")}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td>{batch.batchDate}</td>
                <td>{label(t, batch.status)}</td>
                <td>{bhd(batch.grossFils)}</td>
                <td>{bhd(batch.feeFils)}</td>
                <td>{bhd(batch.netPayoutFils)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t("Recompute transaction statuses")}</h2>
      <p className="admin-muted">
        {t("Re-derives this merchant's transaction statuses from their own captured/refunded amounts. Rows written before the refunds release can carry a status that predates the derivation rule; this backfills them. Rows that already agree are left alone.")}
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role cannot run this backfill. Ask a finance admin.")}
          </p>
        }
      >
        <button type="button" disabled={busy} onClick={() => void handleRecomputeStatuses()}>
          {busy ? t("Working...") : t("Recompute statuses")}
        </button>
      </RequireRole>

      <h2>{t("View as merchant")}</h2>
      <p className="admin-muted">
        {t("Starts a short-lived, audited impersonation grant. It always acts with this merchant's least-privileged support role — never with your admin role — and it expires on its own. A banner stays on screen until you exit it.")}
      </p>
      <button type="button" disabled={busy} onClick={() => void handleImpersonate()}>
        {t("View as merchant")}
      </button>
      {impersonationUrl ? (
        <p>
          {t("Your browser blocked the new tab —")}{" "}
          <a href={impersonationUrl} target="_blank" rel="noreferrer">
            {t("open the merchant dashboard")}
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
