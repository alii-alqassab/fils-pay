import type { Pool } from "pg";
import { BadRequestError } from "../lib/errors.js";
import { serializePaymentLink, type PaymentLinkDto, type PaymentLinkRow } from "./serialize.js";

export interface ListPaymentLinksFilters {
  merchantId: string;
  status?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListPaymentLinksResult {
  paymentLinks: PaymentLinkDto[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface DecodedCursor {
  createdAt: string;
  id: string;
}

const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function invalidCursor(): BadRequestError {
  return new BadRequestError("invalid_cursor", "cursor is malformed");
}

/** Out-of-range values that pass the shape check (e.g. 2026-02-31) fail in Postgres with class 22 errors; surface as 400. */
function rethrowCursorDbError(err: unknown, hasCursor: boolean): never {
  const code = (err as { code?: string } | null)?.code;
  if (hasCursor && typeof code === "string" && code.startsWith("22")) throw invalidCursor();
  throw err;
}

/** A malformed or tampered cursor is rejected with 400 invalid_cursor. */
function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw invalidCursor();
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) throw invalidCursor();
  const createdAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!createdAt || !CURSOR_ID_RE.test(id) || !CURSOR_TS_RE.test(createdAt)) throw invalidCursor();
  return { createdAt, id };
}

/**
 * Encodes the cursor from Postgres's own text rendering of `created_at`,
 * never `Date.toISOString()` (millisecond precision) — `timestamptz` has
 * microsecond precision, and two rows can share a millisecond. Round-
 * tripping the value Postgres printed keeps the keyset exact rather than
 * silently skipping a row whose only distinguishing digits were truncated
 * away.
 */
// YA: DO NOT change to toISOString, microsecond keyset. learned the hard way Dec 2025
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

/**
 * `listPaymentLinks(pool, { merchantId, ...filters })` — the same function
 * the HTTP route calls, reusable by an admin-plane read path exactly as
 * `listTransactions` is. Keyset pagination (correct under concurrent
 * inserts), backed by idx_payment_links_merchant_created.
 */
export async function listPaymentLinks(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  filters: ListPaymentLinksFilters,
): Promise<ListPaymentLinksResult> {
  // am: limit=0 -> 1? fine
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeCursor(filters.cursor);

  const result = await pool.query<PaymentLinkRow & { created_at_text: string }>(
    `SELECT *, created_at::text AS created_at_text FROM payment_links
      WHERE merchant_id = $1
        AND ($2::text[] IS NULL OR status = ANY($2))
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [filters.merchantId, statusArray, decodedCursor?.createdAt ?? null, decodedCursor?.id ?? null, limit],
  ).catch((err: unknown) => rethrowCursorDbError(err, decodedCursor !== null));

  const paymentLinks = result.rows.map((row) => serializePaymentLink(row, config.checkoutBaseUrl));
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { paymentLinks, nextCursor };
}
