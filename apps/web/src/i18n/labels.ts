import { tk, type TranslateVars } from "./translate.js";

type T = (key: string, vars?: TranslateVars) => string;

/**
 * Status and role values come from the API as machine words. They are mapped
 * to translatable labels here; a value this file does not know is shown as
 * the API sent it.
 */
const LABELS: Record<string, string> = {
  active: tk("active"),
  reserved: tk("reserved"),
  paid: tk("paid"),
  canceled: tk("canceled"),
  expired: tk("expired"),
  processing: tk("processing"),
  captured: tk("captured"),
  authorized: tk("authorized"),
  partially_captured: tk("partially captured"),
  voided: tk("voided"),
  failed: tk("failed"),
  refunded: tk("refunded"),
  partially_refunded: tk("partially refunded"),
  pending: tk("pending"),
  succeeded: tk("succeeded"),
  open: tk("open"),
  closed: tk("closed"),
  disabled: tk("disabled"),
  exhausted: tk("exhausted"),
  chargeback: tk("chargeback"),
  owner: tk("owner"),
  finance: tk("finance"),
  support: tk("support"),
};

export function label(t: T, value: string): string {
  return Object.prototype.hasOwnProperty.call(LABELS, value) ? t(LABELS[value] as string) : value;
}
