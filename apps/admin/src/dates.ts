/**
 * The Asia/Bahrain calendar date (YYYY-MM-DD) `offsetDays` from now. This is
 * the business day settlement batches and credit effective dates are keyed
 * on, so it must not depend on the browser's own timezone. Bahrain has
 * observed no DST since 1972, so a fixed +3h shift is exact.
 */
export function bahrainDate(offsetDays = 0, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 3 * 60 * 60 * 1000 + offsetDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}
