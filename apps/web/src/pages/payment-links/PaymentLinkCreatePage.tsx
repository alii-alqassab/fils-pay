import { useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { localDateTimeToIso } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { tk } from "../../i18n/translate.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is entered in BHD and converted by the shared money parser.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();
  const { t } = useI18n();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    let amount: number;
    try {
      amount = parseBhdToFils(amountBhd.trim());
    } catch {
      setError(tk("Enter a valid BHD amount with at most three decimal places."));
      return;
    }
    if (amount <= 0) {
      setError(tk("Amount must be greater than zero."));
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError(tk("Expiry must be a valid date and time."));
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError(tk("Expiry must be in the future."));
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>{t("New payment link")}</h1>

      {error ? <p className="dash-error">{t(error)}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          {t("Amount (BHD)")}
          <input
            type="text"
            inputMode="decimal"
            placeholder="10.000"
            required
            value={amountBhd}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
        </label>
        <p className="dash-muted dash-hint">{t("BHD supports up to three decimal places.")}</p>
        <label>
          {t("Reference (optional)")}
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          {t("Description (optional)")}
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          {t("Expires at")}
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button" disabled={submitting}>
          {submitting ? t("Creating...") : t("Create payment link")}
        </button>
      </form>

      <p>
        <Link to="/dashboard/payment-links">{t("Back to payment links")}</Link>
      </p>
    </section>
  );
}
