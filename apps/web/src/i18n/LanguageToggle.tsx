import { useI18n } from "./I18nProvider.js";

/**
 * Switches between English and Arabic. The label names the language you will
 * get, written in that language, so it is readable to someone who cannot
 * read the current one.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, toggleLang } = useI18n();
  const next = lang === "ar" ? "English" : "العربية";
  return (
    <button
      type="button"
      className={className}
      onClick={toggleLang}
      lang={lang === "ar" ? "en" : "ar"}
      aria-label={lang === "ar" ? "Switch to English" : "التبديل إلى العربية"}
    >
      {next}
    </button>
  );
}
