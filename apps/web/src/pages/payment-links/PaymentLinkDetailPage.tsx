import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPaymentLink, listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { PaymentQrCard } from "../../components/PaymentQrCard.js";
import { bhd, dash } from "../../format.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import type { PaymentLinkDto } from "../../types.js";

/** The list endpoint's own maximum page size. */
const LOOKUP_LIMIT = 100;

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkDto };

/**
 * There is no merchant-authenticated `GET .../payment-links/:id` — the API
 * has the merchant-scoped *list* and the *public* single-token read, and nothing
 * in between. So this page reads the first page of the unfiltered list
 * (newest-first, capped at the endpoint's own 100-row maximum) and finds the
 * row by id.
 *
 * That is correct for a merchant with a normal number of links and genuinely
 * degrades for one whose direct-linked link has aged past row 100 — it will
 * render "not found" for a link that exists. It is left this way deliberately
 * rather than papered over with cursor-walking loops: the real fix is a
 * one-row backend route (`SELECT * ... WHERE id = $1 AND merchant_id = $2`,
 * 404 on no match).
 */
export function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;
  const { t, formatDateTime } = useI18n();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      const result = await listPaymentLinks(merchantId, { limit: LOOKUP_LIMIT });
      const found = result.paymentLinks.find((link) => link.id === id);
      setState(found ? { kind: "loaded", link: found } : { kind: "not_found" });
    } catch (err) {
      setState({ kind: "error", message: describeError(err) });
    }
  }, [merchantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(): Promise<void> {
    if (!merchantId || !id) return;
    if (!window.confirm(t("Cancel this payment link? It can no longer be paid."))) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelPaymentLink(merchantId, id);
      await load();
    } catch (err) {
      // Includes `409 not_cancelable` for a link that is paid, already
      // canceled, or `reserved` mid-payment-attempt.
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission (or no secure context) — the URL is already
      // on screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  }

  if (state.kind === "loading") return <p>{t("Loading...")}</p>;
  if (state.kind === "error") {
    return (
      <section>
        <h1>{t("Payment link")}</h1>
        <p className="dash-error">{t(state.message)}</p>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>{t("Payment link not found")}</h1>
        <p>
          {t("This link is not among your {count} most recent payment links.", { count: LOOKUP_LIMIT })}{" "}
          <Link to="/dashboard/payment-links">{t("Back to payment links")}</Link>
        </p>
      </section>
    );
  }

  const { link } = state;

  return (
    <section>
      <h1>{t("Payment link")}</h1>
      <p className="dash-muted">
        <code>{link.id}</code>
      </p>

      <dl className="dash-dl">
        <dt>{t("Amount")}</dt>
        <dd>{bhd(link.amountFils)}</dd>
        <dt>{t("Currency")}</dt>
        <dd>{link.currency}</dd>
        <dt>{t("Status")}</dt>
        <dd>
          <span className={`dash-status dash-status-${link.status}`}>{label(t, link.status)}</span>
        </dd>
        <dt>{t("Reference")}</dt>
        <dd>{dash(link.reference)}</dd>
        <dt>{t("Description")}</dt>
        <dd>{dash(link.description)}</dd>
        <dt>{t("Expires at")}</dt>
        <dd>{formatDateTime(link.expiresAt)}</dd>
        <dt>{t("Created at")}</dt>
        <dd>{formatDateTime(link.createdAt)}</dd>
        <dt>{t("Paid at")}</dt>
        <dd>{formatDateTime(link.paidAt)}</dd>
        <dt>{t("Canceled at")}</dt>
        <dd>{formatDateTime(link.canceledAt)}</dd>
        <dt>{t("Transaction")}</dt>
        <dd>
          {link.transactionId ? (
            <Link to={`/dashboard/transactions/${link.transactionId}`}>
              <code>{link.transactionId}</code>
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt>{t("Checkout link")}</dt>
        <dd>
          {/* Linked to, never duplicated — /pay/:token is the one checkout
              implementation, and there is no preview of it embedded here. */}
          <a href={link.url} target="_blank" rel="noreferrer" dir="ltr">
            {link.url}
          </a>{" "}
          <button type="button" className="dash-button" onClick={() => void handleCopy(link.url)}>
            {copied ? t("Copied") : t("Copy link")}
          </button>
        </dd>
      </dl>

      {link.status === "active" && new Date(link.expiresAt).getTime() > Date.now() ? (
        <PaymentQrCard url={link.url} linkId={link.id} amountLabel={bhd(link.amountFils)} />
      ) : (
        <p className="dash-muted">
          {t("Scan to pay is only available while a link is active and not expired.")}
        </p>
      )}

      {actionError ? <p className="dash-error">{t(actionError)}</p> : null}

      {link.status === "active" ? (
        <RequireRole allow={["owner", "finance"]}>
          <button
            type="button"
            className="dash-button"
            disabled={submitting}
            onClick={() => void handleCancel()}
          >
            {submitting ? t("Canceling...") : t("Cancel payment link")}
          </button>
        </RequireRole>
      ) : null}

      <p>
        <Link to="/dashboard/payment-links">{t("Back to payment links")}</Link>
      </p>
    </section>
  );
}
