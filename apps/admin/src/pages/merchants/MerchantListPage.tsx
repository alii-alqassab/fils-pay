import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMerchants } from "../../api/merchants.js";
import { bulkApproveKyc } from "../../api/merchantsBulk.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { AdminMerchantSummary, MerchantOnboardingStatus } from "../../types.js";

const ONBOARDING_STATUSES: MerchantOnboardingStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
];

const PAGE_SIZE = 25;

/** The platform's one legitimately cross-merchant view. Searchable by
 *  display name / id / contact email, filterable by onboarding status, and
 *  keyset-paginated like every other list endpoint here. */
export function MerchantListPage() {
  const { t, formatDate } = useI18n();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [statuses, setStatuses] = useState<MerchantOnboardingStatus[]>([]);
  const [merchants, setMerchants] = useState<AdminMerchantSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listMerchants({
          q: appliedQuery || undefined,
          onboardingStatus: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        const page = result.merchants ?? [];
        setMerchants((previous) => (cursor ? [...previous, ...page] : page));
        setNextCursor(result.nextCursor ?? null);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [appliedQuery, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: MerchantOnboardingStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  function toggleSelected(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Header checkbox: select or clear every row currently loaded into the
   *  table, i.e. exactly what the operator can see under the active
   *  search/status filters. */
  function toggleSelectAllLoaded(): void {
    setSelectedIds((previous) =>
      previous.size === merchants.length ? new Set() : new Set(merchants.map((m) => m.id)),
    );
  }

  async function approveSelected(): Promise<void> {
    if (!window.confirm(`Approve KYC for ${selectedIds.size} selected merchant(s)?`)) return;
    setBulkBusy(true);
    setError(null);
    setBulkNotice(null);
    try {
      const result = await bulkApproveKyc([...selectedIds]);
      setBulkNotice(t("Approved KYC for {count} merchant(s).", { count: result.approvedCount }));
      setSelectedIds(new Set());
      await load(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBulkBusy(false);
    }
  }

  const allLoadedSelected = merchants.length > 0 && selectedIds.size === merchants.length;

  return (
    <section>
      <h1>{t("Merchants")}</h1>

      <form
        className="admin-form admin-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedQuery(query.trim());
        }}
      >
        <label>
          {t("Search")}
          <input
            type="search"
            placeholder={t("Display name, merchant id, or contact email")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit">{t("Search")}</button>
      </form>

      <fieldset className="admin-filters">
        <legend>{t("Onboarding status")}</legend>
        {ONBOARDING_STATUSES.map((status) => (
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

      {error ? <p className="admin-error">{t(error)}</p> : null}
      {bulkNotice ? <p className="admin-muted">{bulkNotice}</p> : null}

      {selectedIds.size > 0 ? (
        <div className="admin-form admin-form-inline">
          <span>{t("{count} selected", { count: selectedIds.size })}</span>
          <RequireRole allow={["finance", "super_admin"]}>
            <button type="button" disabled={bulkBusy} onClick={() => void approveSelected()}>
              {t("Bulk approve KYC")}
            </button>
          </RequireRole>
          <button type="button" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
            {t("Clear selection")}
          </button>
        </div>
      ) : null}

      <table className="admin-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label={t("Select all loaded merchants")}
                checked={allLoadedSelected}
                disabled={merchants.length === 0}
                onChange={toggleSelectAllLoaded}
              />
            </th>
            <th>{t("Merchant")}</th>
            <th>{t("Status")}</th>
            <th>{t("Onboarding")}</th>
            <th>{t("KYC")}</th>
            <th>{t("MDR")}</th>
            <th>{t("Mode")}</th>
            <th>{t("Created")}</th>
          </tr>
        </thead>
        <tbody>
          {merchants.map((merchant) => (
            <tr key={merchant.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={t("Select {name}", { name: merchant.displayName })}
                  checked={selectedIds.has(merchant.id)}
                  onChange={() => toggleSelected(merchant.id)}
                />
              </td>
              <td>
                <Link to={`/merchants/${merchant.id}`}>{merchant.displayName}</Link>
                <div className="admin-muted">
                  <code>{merchant.id}</code>
                </div>
              </td>
              <td>{label(t, merchant.status)}</td>
              <td>{label(t, merchant.onboardingStatus)}</td>
              <td>{merchant.kycPassed ? t("passed") : t("not passed")}</td>
              <td>{(merchant.mdrBps / 100).toFixed(2)}%</td>
              <td>{merchant.testMode ? t("test") : t("live")}</td>
              <td>{formatDate(merchant.createdAt)}</td>
            </tr>
          ))}
          {merchants.length === 0 && !loading ? (
            <tr>
              <td colSpan={8}>{t("No merchants match this search.")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>{t("Loading...")}</p> : null}

      {nextCursor ? (
        <button type="button" disabled={loading} onClick={() => void load(nextCursor)}>
          {t("Load more")}
        </button>
      ) : null}
    </section>
  );
}
