/** Company IDs look like FP-7K3M-9QXA (see migration 0086): 8 characters from an alphabet without look-alikes. */
const CODE_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Turns whatever a person typed ("fp-7k3m-9qxa", " FP7K3M9QXA ", "7K3M-9QXA")
 * into the canonical "FP-XXXX-XXXX", or null when it cannot be a company ID.
 */
export function normalizeCompanyCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let compact = input.toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length === 10 && compact.startsWith("FP")) compact = compact.slice(2);
  if (!CODE_ALPHABET.test(compact)) return null;
  return `FP-${compact.slice(0, 4)}-${compact.slice(4)}`;
}
