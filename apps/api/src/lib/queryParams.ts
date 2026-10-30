import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "./errors.js";

export const UUID_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?limit=abc` (or empty/NaN) falls back to the caller's default; clamping stays in the query layer. */
export function parseLimitParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Optional ISO-8601 instant query param; invalid values are a 400, not a DB error. */
export function parseOptionalInstant(name: string, raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) {
    throw new BadRequestError("invalid_date", `${name} must be a valid ISO-8601 date`);
  }
  return d;
}

/** Required-shape business date (YYYY-MM-DD) that is a real calendar day. */
export function assertBusinessDate(name: string, raw: string): string {
  const d = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  // Round-trip rejects rolled-over days such as 2026-02-31.
  if (!d || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new BadRequestError("invalid_date", `${name} must be a valid YYYY-MM-DD date`);
  }
  return raw;
}

/** Wraps toFils so non-integer, negative, string or missing amounts are a 400. */
export function parseAmountFils(value: unknown): Fils {
  try {
    return toFils(value as number);
  } catch {
    throw new BadRequestError("invalid_amount", "amountFils must be a non-negative integer number of fils");
  }
}
