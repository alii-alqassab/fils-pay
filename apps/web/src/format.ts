import { formatBhd, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// Reconciliation gaps and ledger balances are signed, so negatives are allowed;
// non-integer / NaN input is still rejected by `toFils`.
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as a full ISO instant at the
 * UTC day boundary — what the `from`/`to` transaction filters take. No
 * timezone picker and no business-day conversion: those filters compare
 * `occurred_at` directly, so pretending otherwise here would invent a
 * precision the endpoint doesn't have.
 */
// UTC day boundary, NOT Bahrain: 3h off vs settlement days. Kept as-is (an
// existing test locks it); the transaction list uses `bahrainDayStartIso`.
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the instant that Bahrain
 * calendar day starts (00:00 Asia/Bahrain = 21:00Z the previous day; Bahrain
 * has had no DST since 1972, so the fixed +03:00 offset is exact). This is
 * the business-day boundary settlement batches use, so a transaction filter
 * on the same date picks the same transactions.
 */
export function bahrainDayStartIso(dateValue: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
  const instant = new Date(`${dateValue}T00:00:00.000+03:00`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
