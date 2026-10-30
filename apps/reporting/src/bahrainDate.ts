/**
 * Asia/Bahrain observes no daylight-saving transitions (fixed UTC+3 since
 * 1972), so converting a UTC instant to its Asia/Bahrain calendar date is
 * plain arithmetic on a `Date` — no IANA tzdb/Intl lookup needed.
 */

/** The UTC instant at which a Bahrain calendar date ("YYYY-MM-DD") begins. */
export function toUtcFromBahrain(bahrainDateStr: string): Date {
  const local = new Date(`${bahrainDateStr.slice(0, 10)}T00:00:00Z`);
  return new Date(local.getTime() - 3 * 60 * 60 * 1000);
}

/** The Asia/Bahrain calendar date ("YYYY-MM-DD") of a UTC instant. */

export function toBahrainDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
