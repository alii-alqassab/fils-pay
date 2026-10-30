import { useCallback, useEffect, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import {
  getAdjustmentImportRows,
  listAdjustmentImports,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportSummary,
} from "../../types.js";

// FH: another copy of bhd() in admin, claude says extract it
function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

/**
 * "Import adjustments" — paste a CSV of manual balance corrections and apply
 * them. There is no preview step: the paste box submits directly, because an
 * adjustment CSV is assembled and checked in the spreadsheet it came from.
 *
 * The history table below drills into per-row detail, which shows the raw
 * CSV text next to the integer that was actually posted.
 */
export function AdjustmentImportPage() {
  const { t } = useI18n();
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [imports, setImports] = useState<AdjustmentImportSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [openImportId, setOpenImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentImportRowDetail[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25 });
      setImports(page.items);
    } catch (err) {
      setListError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Amounts are BD with three decimals and are parsed server-side with parseBhdToFils. */
  async function handleApply(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await uploadAdjustmentImport(
        csvContent,
        filename.trim() ? filename.trim() : undefined,
      );
      setNotice(
        t("Applied {count} row(s), posting {amount} in total.", {
          count: result.rowCount,
          amount: bhd(result.totalPostedFils),
        }),
      );
      setCsvContent("");
      setFilename("");
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenRows(importId: string): Promise<void> {
    if (openImportId === importId) {
      setOpenImportId(null);
      setRows([]);
      return;
    }
    setRowsError(null);
    try {
      setRows(await getAdjustmentImportRows(importId));
      setOpenImportId(importId);
    } catch (err) {
      setRowsError(describeError(err));
    }
  }

  return (
    <section>
      <h1>{t("Import adjustments")}</h1>
      <p className="admin-muted">
        {t("Applies a CSV of manual balance corrections immediately — one balanced ledger posting per row. Uploading is gated server-side to the finance and super admin roles.")}
      </p>

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            {t("Your role is read-only here. The import history below is still available.")}
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleApply(e)}>
          <label>
            {t("File name (optional)")}
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="march-corrections.csv"
            />
          </label>
          <label>
            {t("CSV (columns: merchantId, amount, reason)")}
            <textarea
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              rows={8}
              placeholder={CSV_PLACEHOLDER}
              required
            />
          </label>
          <button type="submit" disabled={busy || !csvContent.trim()}>
            {busy ? t("Applying…") : t("Apply")}
          </button>
        </form>
      </RequireRole>

      {error ? <p className="admin-error">{t(error)}</p> : null}
      {notice ? <p>{notice}</p> : null}

      <h2>{t("Past imports")}</h2>
      {listError ? <p className="admin-error">{t(listError)}</p> : null}
      {imports.length === 0 ? (
        <p className="admin-muted">{t("No imports yet.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Applied")}</th>
              <th>{t("File")}</th>
              <th>{t("Rows")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {imports.map((item) => (
              <tr key={item.id}>
                <td>{item.appliedAt}</td>
                <td>{item.originalFilename}</td>
                <td>{item.rowCount}</td>
                <td>
                  <button type="button" onClick={() => void handleOpenRows(item.id)}>
                    {openImportId === item.id ? t("Hide rows") : t("View rows")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rowsError ? <p className="admin-error">{t(rowsError)}</p> : null}

      {openImportId ? (
        <div>
          <h3>{t("Rows")}</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("Merchant")}</th>
                <th>{t("CSV amount")}</th>
                <th>{t("Posted")}</th>
                <th>{t("Reason")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td>{row.rowNumber}</td>
                  <td>{row.merchantId}</td>
                  <td>
                    <code>{row.rawAmountText}</code>
                  </td>
                  <td>{bhd(row.parsedAmountFils)}</td>
                  <td>{row.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
