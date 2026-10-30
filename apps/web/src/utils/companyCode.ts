/** Same alphabet as the database (no 0, O, 1, I). */
const CODE_BODY = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Turns what a person typed ("fp-7k3m-9qxa", " FP7K3M9QXA ") into "FP-7K3M-9QXA".
 * Returns null when it cannot be a company ID, so the form can say so before
 * sending anything. The server normalises again; this is only for early feedback.
 */
export function normalizeCompanyCode(input: string): string | null {
  let compact = input.toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length === 10 && compact.startsWith("FP")) compact = compact.slice(2);
  if (!CODE_BODY.test(compact)) return null;
  return `FP-${compact.slice(0, 4)}-${compact.slice(4)}`;
}
