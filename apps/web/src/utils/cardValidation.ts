import { tk } from "../i18n/translate.js";
/**
 * Card-form rules for the hosted checkout: the same checks the API applies
 * (apps/api/src/payments/cardValidation.ts), here for instant feedback while
 * the customer types. The server stays the authority; this only saves a
 * round trip and says what is wrong in plain words.
 *
 * Pure functions, no DOM: easy to test.
 */
export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "jcb" | "diners" | "unionpay" | "unknown";

interface BrandRule {
  brand: CardBrand;
  label: string;
  pattern: RegExp;
  lengths: number[];
  cvvLength: number;
}

// First match wins.
const BRANDS: BrandRule[] = [
  { brand: "amex", label: "American Express", pattern: /^3[47]/, lengths: [15], cvvLength: 4 },
  { brand: "visa", label: "Visa", pattern: /^4/, lengths: [13, 16, 19], cvvLength: 3 },
  { brand: "mastercard", label: "Mastercard", pattern: /^(5[1-5]|2(2[2-9]\d|[3-6]\d\d|7[01]\d|720))/, lengths: [16], cvvLength: 3 },
  { brand: "discover", label: "Discover", pattern: /^(6011|65|64[4-9])/, lengths: [16, 17, 18, 19], cvvLength: 3 },
  { brand: "jcb", label: "JCB", pattern: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19], cvvLength: 3 },
  { brand: "diners", label: "Diners Club", pattern: /^(36|38|39|30[0-5])/, lengths: [14, 15, 16, 17, 18, 19], cvvLength: 3 },
  { brand: "unionpay", label: "UnionPay", pattern: /^62/, lengths: [16, 17, 18, 19], cvvLength: 3 },
];

const MAX_YEARS_AHEAD = 20;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function ruleFor(brand: CardBrand): BrandRule | undefined {
  return BRANDS.find((r) => r.brand === brand);
}

export function detectBrand(digits: string): CardBrand {
  return BRANDS.find((r) => r.pattern.test(digits))?.brand ?? "unknown";
}

export function brandLabel(brand: CardBrand): string {
  return ruleFor(brand)?.label ?? "Card";
}

/** How many digits the number box accepts for this brand. */
export function maxPanDigits(brand: CardBrand): number {
  const lengths = ruleFor(brand)?.lengths;
  return lengths ? Math.max(...lengths) : 19;
}

/** 4 for American Express, otherwise 3. */
export function cvvLength(brand: CardBrand): number {
  return ruleFor(brand)?.cvvLength ?? 3;
}

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

/** "4242424242424242" -> "4242 4242 4242 4242"; American Express groups as 4-6-5. */
export function formatPan(digits: string): string {
  const d = digitsOnly(digits);
  const groups = detectBrand(d) === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 4];
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= d.length) break;
    parts.push(d.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}

/** Cleans what was typed or pasted in the number box: digits only, capped at the brand's length, grouped. */
export function sanitizePanInput(raw: string): string {
  let d = digitsOnly(raw);
  d = d.slice(0, maxPanDigits(detectBrand(d)));
  return formatPan(d);
}

/** Where the caret should sit after reformatting, given how many digits were left of it. */
export function caretForDigits(formatted: string, digitsBeforeCaret: number): number {
  if (digitsBeforeCaret <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]!)) seen += 1;
    if (seen === digitsBeforeCaret) return i + 1;
  }
  return formatted.length;
}

/**
 * Expiry box: type "1230", get "12/30". A first digit of 2-9 becomes "02".."09".
 * `previous` lets backspace work over the slash instead of fighting it.
 */
export function formatExpiryInput(raw: string, previous = ""): string {
  let d = digitsOnly(raw);
  // Browser autofill may give MMYYYY ("122030"): keep MMYY.
  if (d.length === 6 && d.slice(2, 4) === "20") d = d.slice(0, 2) + d.slice(4);
  d = d.slice(0, 4);
  if (d.length === 0) return "";
  if (d.length === 1 && Number(d) > 1) d = "0" + d;
  const month = d.slice(0, 2);
  const year = d.slice(2);
  const deleting = raw.length < previous.length;
  if (year.length > 0) return `${month}/${year}`;
  if (d.length === 2 && !deleting) return `${month}/`;
  return month;
}

/** "12/30" -> { month: 12, year: 2030 }; null while incomplete or malformed. */
export function parseExpiry(value: string): { month: number; year: number } | null {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return { month: Number(m[1]), year: 2000 + Number(m[2]) };
}

export type FieldName = "name" | "pan" | "expiry" | "cvv";
export type FieldErrors = Partial<Record<FieldName, string>>;

export function validateName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "") return tk("Enter the name shown on the card.");
  if (name.length < 2 || !NAME_RE.test(name)) return tk("Use letters only for the name on the card.");
  if (name.length > 60) return tk("That name is too long.");
  return null;
}

export function validatePan(value: string): string | null {
  const d = digitsOnly(value);
  if (d === "") return tk("Enter your card number.");
  if (/[^\d\s-]/.test(value)) return tk("The card number can only contain digits.");
  const brand = detectBrand(d);
  const lengths = ruleFor(brand)?.lengths;
  if (lengths ? !lengths.includes(d.length) : d.length < 12 || d.length > 19) {
    return d.length < (lengths?.[0] ?? 12) ? tk("That card number is too short.") : tk("That card number has too many digits.");
  }
  if (!passesLuhn(d)) return tk("That card number is not valid. Please check it.");
  return null;
}

export function validateExpiry(value: string, now: Date = new Date()): string | null {
  if (value.trim() === "") return tk("Enter the expiry date as MM/YY.");
  const exp = parseExpiry(value);
  if (!exp) return tk("Enter the expiry date as MM/YY.");
  if (exp.month < 1 || exp.month > 12) return tk("The month must be between 01 and 12.");
  // Valid through the last day of its month.
  const nowIndex = now.getFullYear() * 12 + now.getMonth();
  const cardIndex = exp.year * 12 + (exp.month - 1);
  if (cardIndex < nowIndex) return tk("This card has expired.");
  if (cardIndex > nowIndex + MAX_YEARS_AHEAD * 12) return tk("That expiry date is too far in the future.");
  return null;
}

export function validateCvv(value: string, brand: CardBrand): string | null {
  const want = cvvLength(brand);
  if (value === "") return `Enter the ${want}-digit security code.`;
  if (!/^\d+$/.test(value) || value.length !== want) {
    return brand === "amex" ? tk("American Express security codes have 4 digits (on the front).") : `The security code has ${want} digits (on the back).`;
  }
  return null;
}

export function validateAll(values: { name: string; pan: string; expiry: string; cvv: string }, now: Date = new Date()): FieldErrors {
  const brand = detectBrand(digitsOnly(values.pan));
  const errors: FieldErrors = {};
  const name = validateName(values.name);
  const pan = validatePan(values.pan);
  const expiry = validateExpiry(values.expiry, now);
  const cvv = validateCvv(values.cvv, brand);
  if (name) errors.name = name;
  if (pan) errors.pan = pan;
  if (expiry) errors.expiry = expiry;
  if (cvv) errors.cvv = cvv;
  return errors;
}

/** The API answers `fields: { pan: "luhn", expiry: "expired", ... }`; turn those codes into the same plain words. */
export function messageForServerField(field: string, code: string): { field: FieldName; message: string } | null {
  switch (field) {
    case "pan":
      if (code === "required") return { field: "pan", message: tk("Enter your card number.") };
      if (code === "too_short") return { field: "pan", message: tk("That card number is too short.") };
      if (code === "invalid_length") return { field: "pan", message: tk("That card number has the wrong number of digits.") };
      return { field: "pan", message: tk("That card number is not valid. Please check it.") };
    case "expiry":
      if (code === "expired") return { field: "expiry", message: tk("This card has expired.") };
      if (code === "too_far") return { field: "expiry", message: tk("That expiry date is too far in the future.") };
      return { field: "expiry", message: tk("Check the expiry date (MM/YY).") };
    case "cvv":
      return { field: "cvv", message: tk("Check the security code.") };
    case "cardholderName":
      return { field: "name", message: tk("Use letters only for the name on the card.") };
    default:
      return null;
  }
}

/** A fresh idempotency key. `crypto.randomUUID` only exists on secure pages (HTTPS/localhost);
 *  reaching the site over plain http on a LAN address would otherwise crash the Pay button. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
