import type { Pool, QueryResult } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

interface StreamingTransactionRow extends TransactionRow {
  /** PostgreSQL text retains the full timestamptz precision for keyset paging. */
  cursor_occurred_at: string;
}

function csvEscape(value: string): string {
  // Quoting a CSV cell does not stop spreadsheet applications from
  // evaluating formulas. Prefix dangerous cells (including cells with
  // leading whitespace before a formula marker) with a literal apostrophe.
  const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  if (safeValue.includes(",") || safeValue.includes('"') || /[\r\n]/.test(safeValue)) {
    return `"${safeValue.replace(/"/g, '""')}"`;
  }
  return safeValue;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Builds the CSV body for `GET /v1/transactions/export`. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE merchant_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR occurred_at <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY occurred_at ASC`,
    [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray],
  );

  const header = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const lines = result.rows.map(toCsvRow);
  return [header, ...lines].join("\n");
}


/** Cursor-paginated export for large date ranges. */
export async function streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  write: (chunk: string) => void,
): Promise<void> {
  write("id,status,amount_bhd,captured_bhd,reference,occurred_at\n");

  let cursorOccurredAt: string | null = null;
  let cursorId: string | null = null;
  const PAGE_SIZE = 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
    const result: QueryResult<StreamingTransactionRow> = await pool.query<StreamingTransactionRow>(
      `SELECT transactions.*, transactions.occurred_at::text AS cursor_occurred_at
         FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND (
            $5::timestamptz IS NULL
            OR (occurred_at, id) > ($5::timestamptz, $6::uuid)
          )
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray, cursorOccurredAt, cursorId, PAGE_SIZE],
    );

    for (const row of result.rows) {
      write(toCsvRow(row) + "\n");
    }

    if (result.rows.length < PAGE_SIZE) break;
    const lastRow: StreamingTransactionRow = result.rows[result.rows.length - 1]!;
    cursorOccurredAt = lastRow.cursor_occurred_at;
    cursorId = lastRow.id;
  }
}
