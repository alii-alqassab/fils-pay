import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { localeFor, translate, type Lang, type TranslateVars } from "./translate.js";

const STORAGE_KEY = "filspay.lang";

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: string, vars?: TranslateVars) => string;
  formatDateTime: (iso: string | null | undefined) => string;
  formatDate: (iso: string | null | undefined) => string;
  formatTime: (iso: string | null | undefined) => string;
}

function build(lang: Lang, setLang: (lang: Lang) => void): I18nValue {
  const locale = localeFor(lang);
  const format = (iso: string | null | undefined, kind: "dateTime" | "date" | "time"): string => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    if (kind === "date") return date.toLocaleDateString(locale);
    if (kind === "time") return date.toLocaleTimeString(locale);
    return date.toLocaleString(locale);
  };
  return {
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
    setLang,
    toggleLang: () => setLang(lang === "ar" ? "en" : "ar"),
    t: (key, vars) => translate(lang, key, vars),
    formatDateTime: (iso) => format(iso, "dateTime"),
    formatDate: (iso) => format(iso, "date"),
    formatTime: (iso) => format(iso, "time"),
  };
}

// Used when a component renders outside the provider (e.g. in isolation):
// plain English, never a crash.
const I18nContext = createContext<I18nValue>(build("en", () => undefined));

/**
 * A `?lang=ar` or `?lang=en` in the address wins, so a link can open the page in
 * a chosen language; it is remembered like a click on the toggle. Otherwise the
 * saved choice, otherwise English.
 */
function readInitialLang(): Lang {
  try {
    const requested = new URLSearchParams(window.location.search).get("lang");
    if (requested === "ar" || requested === "en") {
      window.localStorage.setItem(STORAGE_KEY, requested);
      return requested;
    }
  } catch {
    // No usable address or storage: fall through to the saved choice.
  }
  return readStoredLang();
}

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    // Storage blocked (private window, site data off): just start in English.
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this visit.
    }
  }, []);

  // Before paint, so a returning Arabic reader never sees a flash of LTR.
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const value = useMemo(() => build(lang, setLang), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
