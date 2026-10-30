import { BadRequestError } from "../lib/errors.js";
import type { TransactionReportFilter } from "./transactionsReportQuery.js";

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestError("invalid_filter", `filter.${field} must be a string`);
  return value;
}

function optionalDate(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field);
  if (text === undefined) return undefined;
  if (Number.isNaN(new Date(text).getTime())) {
    throw new BadRequestError("invalid_filter", `filter.${field} must be a valid ISO 8601 date`);
  }
  return text;
}

/**
 * Parses the client-supplied `filter` query value into the report predicate.
 * Every field is checked here so a malformed value is a 400 instead of a
 * database cast error (500). `merchantId` is deliberately never read: tenant
 * scope comes from the authenticated actor.
 */
export function parseReportFilter(raw: string | undefined): Omit<TransactionReportFilter, "merchantId"> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError("invalid_filter", "filter must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("invalid_filter", "filter must be valid JSON");
  }
  const obj = parsed as Record<string, unknown>;
  return {
    status: optionalString(obj.status, "status"),
    from: optionalDate(obj.from, "from"),
    to: optionalDate(obj.to, "to"),
  };
}
