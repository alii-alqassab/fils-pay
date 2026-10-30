import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { describeError } from "../../api/client.js";
import {
  getBusinessProfile,
  listKycDocuments,
  uploadKycDocument,
  type BusinessProfile,
  type KycDocument,
} from "../../api/onboarding.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { CompanyIdCard } from "../../components/CompanyIdCard.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { tk } from "../../i18n/translate.js";

const DOCUMENT_TYPES = [
  ["commercial_registration", tk("Commercial registration (PDF)")],
  ["owner_id", tk("Owner ID (PDF, JPEG or PNG)")],
  ["proof_of_address", tk("Proof of address (PDF, JPEG or PNG)")],
  ["bank_letter", tk("Bank letter (PDF, JPEG or PNG)")],
] as const;

function describeOnboardingStatus(status: string | undefined): string {
  switch (status) {
    case undefined: return tk("Loading");
    case "approved": return tk("Approved");
    case "rejected": return tk("Not approved");
    case "under_review": return tk("Waiting for admin approval (under review)");
    default: return tk("Waiting for admin approval (upload your documents)");
  }
}

export function OnboardingPage() {
  const { me, refresh } = useDashboardAuth();
  const { t } = useI18n();
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [documents, setDocuments] = useState<KycDocument[]>([]);
  const [documentType, setDocumentType] = useState<string>(DOCUMENT_TYPES[0][0]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const merchantId = me?.merchant.id;

  const load = useCallback(async () => {
    if (!merchantId) return;
    try {
      // The document list is owner/finance-only server-side (403 for
      // support), while the profile read is open to any role — so a support
      // user gets the profile instead of a failed Promise.all and no page.
      const canListDocuments = me?.role === "owner" || me?.role === "finance";
      const [nextProfile, nextDocuments] = await Promise.all([
        getBusinessProfile(merchantId),
        canListDocuments ? listKycDocuments(merchantId) : Promise.resolve([]),
      ]);
      setProfile(nextProfile);
      setDocuments(nextDocuments);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId, me?.role, refresh]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || !file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await uploadKycDocument(merchantId, documentType, file);
      setFile(null);
      const input = document.getElementById("kyc-file") as HTMLInputElement | null;
      if (input) input.value = "";
      setNotice(tk("Document uploaded. Your review status has been updated."));
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dash-onboarding">
      <h1>{t("Business verification")}</h1>
      <p>{t("Status:")} <strong>{t(describeOnboardingStatus(me?.merchant.onboardingStatus))}</strong></p>
      {me?.merchant.onboardingStatus === "approved" ? (
        <p className="dash-notice">{t("Your business is approved.")} <Link to="/dashboard/payment-links/new">{t("Create a payment link")}</Link>.</p>
      ) : (
        <p className="dash-muted">{t("Complete your documents so the FilsPay team can review your business. Payments and payment links become available after admin approval.")}</p>
      )}
      <CompanyIdCard />
      {error ? <p className="dash-error" role="alert">{t(error)}</p> : null}
      {notice ? <p className="dash-notice" role="status">{t(notice)}</p> : null}

      {profile ? (
        <div>
          <h2>{t("Business details")}</h2>
          <dl className="dash-dl">
            <dt>{t("Legal business name")}</dt>
            <dd>{profile.legalName}</dd>
            <dt>{t("Business registration number")}</dt>
            <dd><bdi>{profile.registrationNumber}</bdi></dd>
            <dt>{t("Business address")}</dt>
            <dd>{profile.addressLine1}, {profile.city}, {profile.country}</dd>
            <dt>{t("Work email")}</dt>
            <dd><bdi>{profile.contactEmail}</bdi></dd>
            <dt>{t("Contact phone")}</dt>
            <dd><bdi>{profile.contactPhone}</bdi></dd>
          </dl>
        </div>
      ) : null}

      <h2>{t("Verification documents")}</h2>
      {documents.length === 0 ? <p>{me?.role === "support" ? t("Verification documents are visible to owner and finance users.") : t("No documents uploaded yet.")}</p> : (
        <ul>{documents.map((item) => (
          <li key={item.id}>
            {t(DOCUMENT_TYPES.find(([type]) => type === item.documentType)?.[1] ?? item.documentType)}: {item.fileName}
            {" · "}<a href={`${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000"}/v1/merchants/${encodeURIComponent(merchantId ?? "")}/kyc/documents/${encodeURIComponent(item.id)}/file`} target="_blank" rel="noreferrer">{t("View")}</a>
          </li>
        ))}</ul>
      )}

      {me?.role === "owner" || me?.role === "finance" ? (
        <form className="dash-form" onSubmit={(event) => void submit(event)}>
          <label>{t("Document type")}
            <select value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
              {DOCUMENT_TYPES.map(([value, text]) => <option key={value} value={value}>{t(text)}</option>)}
            </select>
          </label>
          <label>{t("File")}<input id="kyc-file" type="file" required accept={documentType === "commercial_registration" ? "application/pdf,.pdf" : "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <button type="submit" className="dash-button" disabled={busy || !file}>{busy ? t("Uploading...") : t("Upload document")}</button>
        </form>
      ) : null}
    </section>
  );
}
