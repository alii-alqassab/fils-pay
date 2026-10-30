import { ar } from "./ar.js";

export type Lang = "en" | "ar";
export type TranslateVars = Record<string, string | number>;

/**
 * The English text is the key. A key with no Arabic entry falls back to the
 * English text, so a missing translation is never a blank or a crash.
 * `{name}` placeholders are filled from `vars`; one with no matching var is
 * left as written.
 */
export function translate(lang: Lang, key: string, vars?: TranslateVars): string {
  const template = lang === "ar" ? (ar[key] ?? key) : key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Arabic dates keep Latin digits and the Gregorian calendar so they match
 * the amounts (which are always shown as `4.750 BHD`) and Bahrain's civil
 * calendar. English keeps the browser's own formatting, as before.
 */
export function localeFor(lang: Lang): string | undefined {
  return lang === "ar" ? "ar-BH-u-ca-gregory-nu-latn" : undefined;
}

/**
 * Marks an English string that is stored and translated later (for example an
 * error kept in state and rendered through `t`). It returns the text
 * unchanged; it exists so the translation test can find the key.
 */
export function tk<T extends string>(key: T): T {
  return key;
}
