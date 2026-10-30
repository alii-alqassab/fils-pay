import { useState } from "react";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { useI18n } from "../i18n/I18nProvider.js";

/**
 * Owner-only card about the company ID.
 *  - approved: shows the ID with a Copy button
 *  - not approved yet: says clearly that the company waits for admin approval
 * Other roles see nothing (the API never sends them the ID).
 */
export function CompanyIdCard() {
  const { me } = useDashboardAuth();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  if (!me || me.role !== "owner") return null;

  const status = me.merchant.onboardingStatus;
  if (status !== "approved" || !me.companyCode) {
    return (
      <div className="dash-confirm" role="status">
        <strong>{t("Waiting for admin approval.")}</strong>{" "}
        {status === "rejected"
          ? t("Your company was not approved. Check your email for the reviewer's note.")
          : t("Your company ID appears here as soon as the FilsPay team approves your business.")}
      </div>
    );
  }

  const code = me.companyCode;
  async function copy(): Promise<void> {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="dash-notice dash-company-id" role="status">
      <div>
        <span className="dash-muted">{t("Your company ID:")} </span>
        <code className="dash-company-code">{code}</code>{" "}
        <button type="button" className="dash-button" onClick={() => void copy()}>
          {copied ? t("Copied") : t("Copy")}
        </button>
        {copyFailed ? <span className="dash-muted"> {t("Copy failed, select the ID and copy it by hand.")}</span> : null}
      </div>
      <p className="dash-muted">{t("Share it only with colleagues you trust; you approve each person under Team.")}</p>
    </div>
  );
}
