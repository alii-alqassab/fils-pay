import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError } from "../lib/errors.js";

export const MAX_SAVED_FILTERS_PER_MERCHANT = 50;
export const MAX_SAVED_FILTER_NAME_LENGTH = 100;
export const MAX_SAVED_FILTER_BYTES = 8 * 1024;

export interface SavedFilterDto {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  createdAt: string;
}

interface SavedFilterRow {
  id: string;
  name: string;
  filter_json: Record<string, unknown>;
  created_at: Date;
}

// am: result.rows[0]! below will throw a TypeError not a 500 if insert returns nothing? same thing really. ignore
function serialize(row: SavedFilterRow): SavedFilterDto {
  return { id: row.id, name: row.name, filter: row.filter_json, createdAt: row.created_at.toISOString() };
}

/**
 * Stores a named filter for reuse. The filter body is opaque JSONB here,
 * never interpreted or executed at write time — there is nothing for this
 * function to validate beyond "is it a JSON object." Interpretation
 * happens only later, at report-run time
 * (reporting/transactionsReportQuery.ts), scoped by that endpoint's own
 * auth context, not by anything persisted here.
 */
export async function createSavedFilter(
  pool: Pool,
  input: { merchantId: string; name: string; filter: Record<string, unknown> },
): Promise<SavedFilterDto> {
  const name = input.name.trim();
  if (!name) throw new BadRequestError("invalid_request", "name is required");
  if (name.length > MAX_SAVED_FILTER_NAME_LENGTH) {
    throw new BadRequestError("saved_filter_name_too_long", `name must be at most ${MAX_SAVED_FILTER_NAME_LENGTH} characters`);
  }
  const serialized = JSON.stringify(input.filter);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SAVED_FILTER_BYTES) {
    throw new BadRequestError("saved_filter_too_large", `filter must be at most ${MAX_SAVED_FILTER_BYTES} bytes`);
  }
  return withTransaction(pool, async (client) => {
    // Serialise concurrent creates for one merchant on its row so the
    // count-then-insert below cannot race past the cap.
    await client.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [input.merchantId]);
    const count = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reporting_saved_filters WHERE merchant_id = $1`,
      [input.merchantId],
    );
    if (Number(count.rows[0]!.n) >= MAX_SAVED_FILTERS_PER_MERCHANT) {
      throw new ConflictError("saved_filter_limit_reached", `at most ${MAX_SAVED_FILTERS_PER_MERCHANT} saved filters per merchant`);
    }
    const result = await client.query<SavedFilterRow>(
      `INSERT INTO reporting_saved_filters (merchant_id, name, filter_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, filter_json, created_at`,
      [input.merchantId, name, serialized],
    );
    return serialize(result.rows[0]!);
  });
}

/**
 * Lists a merchant's saved filters, newest first. Scoped by merchant_id;
 * there is no pagination because a merchant is capped at 50 saved filters
 * by createSavedFilter (application-level, enforced under a merchant row
 * lock; there is no database constraint for it).
 */
export async function listSavedFilters(pool: Pool, input: { merchantId: string }): Promise<SavedFilterDto[]> {
  const result = await pool.query<SavedFilterRow>(
    `SELECT id, name, filter_json, created_at FROM reporting_saved_filters
      WHERE merchant_id = $1
      ORDER BY created_at DESC`,
    [input.merchantId],
  );
  return result.rows.map(serialize);
}
