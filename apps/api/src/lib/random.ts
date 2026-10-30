import { randomInt } from "node:crypto";

/**
 * Generates a string of `n` random decimal digits (e.g. "042817"), drawn
 * from a CSPRNG (OTP codes are a login second factor). Each digit is an
 * independent uniform draw, so the result is uniform over all 10^n strings
 * for any n (no 2^48 randomInt range limit to worry about).
 */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += randomInt(0, 10).toString();
  return out;
}

/** Generates a string of `n` characters drawn uniformly (CSPRNG) from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
