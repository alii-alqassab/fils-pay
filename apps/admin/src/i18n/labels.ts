import { tk, type TranslateVars } from "./translate.js";

type T = (key: string, vars?: TranslateVars) => string;

/**
 * Role and status values come from the API as machine words. They are mapped
 * to translatable labels here; a value this file does not know is shown as
 * the API sent it.
 */
const LABELS: Record<string, string> = {
  support: tk("support"),
  finance: tk("finance"),
  super_admin: tk("super admin"),
  master: tk("master"),
  active: tk("active"),
  suspended: tk("suspended"),
  disabled: tk("disabled"),
  pending: tk("pending"),
  pending_approval: tk("pending approval"),
  submitted: tk("submitted"),
  under_review: tk("under review"),
  approved: tk("approved"),
  rejected: tk("rejected"),
  posted: tk("posted"),
  expired: tk("expired"),
  paid: tk("paid"),
  failed: tk("failed"),
  succeeded: tk("succeeded"),
  exhausted: tk("exhausted"),
  open: tk("open"),
  closed: tk("closed"),
};

export function label(t: T, value: string): string {
  return Object.prototype.hasOwnProperty.call(LABELS, value) ? t(LABELS[value] as string) : value;
}
