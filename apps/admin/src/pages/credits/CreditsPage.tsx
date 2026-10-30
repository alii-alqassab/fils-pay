import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import {
  approveCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "../../api/credits.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import { tk } from "../../i18n/translate.js";
import type { CreditRequestDto, CreditRequestStatus } from "../../types.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const STATUS_TABS: Array<{ value: CreditRequestStatus; label: string }> = [
  { value: "pending_approval", label: tk("Awaiting approval") },
  { value: "posted", label: tk("Posted") },
  { value: "rejected", label: tk("Rejected") },
];

/**
 * The checker half of maker-checker: every credit waiting on a second
 * operator, plus the history of what was posted or declined.
 *
 * Approve and Reject are wrapped in `RequireRole` so a support operator
 * isn't shown a control that would answer 403 — the gate itself lives on the
 * route, server-side.
 */
// approve is gated server side but issuing (MerchantDetail) only in the ui? — am
// MK: both are server-side
export function CreditsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CreditRequestStatus>("pending_approval");
  const [items, setItems] = useState<CreditRequestDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [pendingReject, setPendingReject] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const page = await listCreditRequests({ status });
      setItems(page.items ?? []);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    try {
      const page = await listCreditRequests({ status, cursor: nextCursor });
      setItems((current) => [...current, ...(page.items ?? [])]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }

  async function handleApprove(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      const record = await approveCreditRequest(id);
      setNotice(
        t("Approved. {amount} journaled to entry group {group}.", {
          amount: bhd(record.postedAmountFils),
          group: record.ledgerEntryGroupId ?? t("(unknown)"),
        }),
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await rejectCreditRequest(id, rejectReason.trim() ? rejectReason.trim() : undefined);
      setNotice(t("Credit request rejected. Nothing was journaled."));
      setPendingReject(null);
      setRejectReason("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h1>{t("Merchant credits")}</h1>
      <p className="admin-muted">
        {t("Manual credits are journaled to the ledger like any other money movement. A credit above the approval limit cannot post until a second finance or super admin operator — not the one who raised it — approves it.")}
      </p>

      <nav className="admin-nav">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            disabled={tab.value === status}
            onClick={() => setStatus(tab.value)}
          >
            {t(tab.label)}
          </button>
        ))}
      </nav>

      {loadError ? <p className="admin-error">{t(loadError)}</p> : null}
      {actionError ? <p className="admin-error">{t(actionError)}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      {items.length === 0 ? (
        <p className="admin-muted">{t("Nothing here.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Requested by")}</th>
              <th>{t("Merchant")}</th>
              <th>{t("Reason")}</th>
              <th>{t("Base")}</th>
              <th>{t("Fee reversal")}</th>
              <th>{t("Posted total")}</th>
              <th>{t("Effective date")}</th>
              <th>{t("Approved by")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.requestedByDisplayName}</td>
                <td>
                  <Link to={`/merchants/${item.merchantId}`}>
                    <code>{item.merchantId.slice(0, 8)}</code>
                  </Link>
                </td>
                <td>
                  {item.reasonCode}
                  {item.memo ? <div className="admin-muted">{item.memo}</div> : null}
                </td>
                <td>{bhd(item.baseAmountFils)}</td>
                <td>{item.feeReversalFils > 0 ? bhd(item.feeReversalFils) : "-"}</td>
                <td>
                  <strong>{bhd(item.postedAmountFils)}</strong>
                </td>
                <td>{item.effectiveDate}</td>
                <td>{item.approvedByDisplayName ?? "-"}</td>
                <td>
                  {item.status === "pending_approval" ? (
                    <RequireRole
                      allow={["finance", "super_admin"]}
                      fallback={<span className="admin-muted">{t("finance role required")}</span>}
                    >
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void handleApprove(item.id)}
                      >
                        {t("Approve")}
                      </button>{" "}
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => setPendingReject(item.id)}
                      >
                        {t("Reject")}
                      </button>
                    </RequireRole>
                  ) : (
                    label(t, item.status)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingReject ? (
        <div className="admin-confirm">
          <p>
            <strong>{t("Reject this credit request?")}</strong>{" "}
            {t("Nothing is journaled, and the request cannot be approved afterwards.")}
          </p>
          <label>
            {t("Reason (optional — recorded in the admin audit log)")}
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busyId === pendingReject}
            onClick={() => void handleReject(pendingReject)}
          >
            {t("Yes, reject it")}
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setPendingReject(null);
              setRejectReason("");
            }}
          >
            {t("Cancel")}
          </button>
        </div>
      ) : null}

      {nextCursor ? (
        <p>
          <button type="button" onClick={() => void loadMore()}>
            {t("Load more")}
          </button>
        </p>
      ) : null}
    </section>
  );
}
