import { AppError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

/**
 * Real-world card input checks, applied BEFORE anything is reserved, authorized or hashed:
 * number (digits, brand length, Luhn checksum), expiry (valid month, not expired, not absurdly far
 * away), security code (3 digits, 4 for American Express) and the optional name on the card.
 *
 * Errors are reported per field as short codes and never contain the submitted values. The web
 * checkout (apps/web/src/utils/cardValidation.ts) applies the same rules for instant feedback; this
 * module is the one that cannot be bypassed.
 */
export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "jcb" | "diners" | "unionpay" | "unknown";

interface BrandRule {
  brand: CardBrand;
  pattern: RegExp;
  lengths: number[];
  cvvLength: number;
}

// Order matters: the first match wins.
const BRAND_RULES: BrandRule[] = [
  { brand: "amex", pattern: /^3[47]/, lengths: [15], cvvLength: 4 },
  { brand: "visa", pattern: /^4/, lengths: [13, 16, 19], cvvLength: 3 },
  { brand: "mastercard", pattern: /^(5[1-5]|2(2[2-9]\d|[3-6]\d\d|7[01]\d|720))/, lengths: [16], cvvLength: 3 },
  { brand: "discover", pattern: /^(6011|65|64[4-9])/, lengths: [16, 17, 18, 19], cvvLength: 3 },
  { brand: "jcb", pattern: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19], cvvLength: 3 },
  { brand: "diners", pattern: /^(36|38|39|30[0-5])/, lengths: [14, 15, 16, 17, 18, 19], cvvLength: 3 },
  { brand: "unionpay", pattern: /^62/, lengths: [16, 17, 18, 19], cvvLength: 3 },
];

export function detectCardBrand(digits: string): CardBrand {
  return BRAND_RULES.find((r) => r.pattern.test(digits))?.brand ?? "unknown";
}

/** Luhn checksum over a string of digits. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface ValidCard {
  card: SimulatedCardInput;
  brand: CardBrand;
  last4: string;
}

export type CardFieldErrors = Partial<Record<"pan" | "expiry" | "cvv" | "cardholderName", string>>;

const MAX_YEARS_AHEAD = 20;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

/** Returns the normalized card (digits-only number, trimmed name) or the per-field reasons. */
export function validateCard(raw: unknown, now: Date = new Date()): { ok: true; value: ValidCard } | { ok: false; fields: CardFieldErrors } {
  const fields: CardFieldErrors = {};
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  // --- number ---
  const rawPan = typeof input.pan === "string" ? input.pan : typeof input.pan === "number" ? String(input.pan) : "";
  const pan = rawPan.replace(/[ -]/g, "");
  let brand: CardBrand = "unknown";
  if (pan === "") {
    fields.pan = "required";
  } else if (!/^\d+$/.test(pan)) {
    fields.pan = "invalid_number";
  } else {
    brand = detectCardBrand(pan);
    const rule = BRAND_RULES.find((r) => r.brand === brand);
    const lengths = rule?.lengths;
    if (lengths ? !lengths.includes(pan.length) : pan.length < 12 || pan.length > 19) {
      fields.pan = pan.length < (lengths?.[0] ?? 12) ? "too_short" : "invalid_length";
    } else if (!passesLuhn(pan)) {
      fields.pan = "luhn";
    }
  }

  // --- expiry ---
  const month = input.expiryMonth;
  const year = input.expiryYear;
  if (month === undefined || month === null || month === "" || year === undefined || year === null || year === "") {
    fields.expiry = "required";
  } else if (!Number.isInteger(month) || !Number.isInteger(year) || (month as number) < 1 || (month as number) > 12) {
    fields.expiry = "invalid_month";
  } else if ((year as number) < 1000 || (year as number) > 9999) {
    fields.expiry = "invalid_year";
  } else {
    // A card is valid through the LAST day of its expiry month.
    const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
    const cardIndex = (year as number) * 12 + ((month as number) - 1);
    if (cardIndex < nowIndex) fields.expiry = "expired";
    else if (cardIndex > nowIndex + MAX_YEARS_AHEAD * 12) fields.expiry = "too_far";
  }

  // --- security code ---
  const cvv = typeof input.cvv === "string" ? input.cvv : typeof input.cvv === "number" ? String(input.cvv) : "";
  const cvvRule = BRAND_RULES.find((r) => r.brand === brand);
  if (cvv === "") {
    fields.cvv = "required";
  } else if (!/^\d+$/.test(cvv)) {
    fields.cvv = "invalid_cvv";
  } else if (cvvRule ? cvv.length !== cvvRule.cvvLength : cvv.length !== 3 && cvv.length !== 4) {
    fields.cvv = "invalid_cvv";
  }

  // --- name (optional for API callers; the checkout page requires it) ---
  let cardholderName: string | undefined;
  if (input.cardholderName !== undefined && input.cardholderName !== null && input.cardholderName !== "") {
    const name = typeof input.cardholderName === "string" ? input.cardholderName.trim().replace(/\s+/g, " ") : "";
    if (name.length < 2 || name.length > 60 || !NAME_RE.test(name)) fields.cardholderName = "invalid_name";
    else cardholderName = name;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      brand,
      last4: pan.slice(-4),
      card: {
        pan,
        expiryMonth: month as number,
        expiryYear: year as number,
        cvv,
        ...(cardholderName ? { cardholderName } : {}),
      },
    },
  };
}

/** Validates or throws the 400 `invalid_card` error (with `fields`) the clients expect. */
export function requireValidCard(raw: unknown, now: Date = new Date()): ValidCard {
  const result = validateCard(raw, now);
  if (!result.ok) {
    throw new AppError(400, "invalid_card", "The card details are not valid.", result.fields as Record<string, string>);
  }
  return result.value;
}
