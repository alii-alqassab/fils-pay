import { useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider.js";
import { tk } from "../i18n/translate.js";
import { buildQr, qrPath, qrToPngBlob, qrViewSize } from "../utils/qr.js";

interface PaymentQrCardProps {
  /** The exact checkout URL the QR code opens. */
  url: string;
  /** Used for the downloaded file name. */
  linkId: string;
  /** Already-formatted amount, shown in the share text. */
  amountLabel: string;
}

/**
 * "Scan to pay": the checkout link as a QR code a customer can scan with a
 * phone camera, plus a PNG download and (where the browser has one) the
 * native share sheet. The code encodes `url` unchanged — /pay/:token stays the
 * one checkout implementation.
 */
export function PaymentQrCard({ url, linkId, amountLabel }: PaymentQrCardProps) {
  const { t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const qr = useMemo(() => {
    try {
      return buildQr(url);
    } catch {
      return null;
    }
  }, [url]);

  if (!qr) {
    return (
      <p className="dash-error">{t("This link is too long to show as a QR code. Share the link instead.")}</p>
    );
  }

  const view = qrViewSize(qr);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function handleDownload(): Promise<void> {
    if (!qr) return;
    setBusy(true);
    try {
      const blob = await qrToPngBlob(qr);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `filspay-payment-link-${linkId.slice(0, 8)}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage(tk("QR code downloaded."));
    } catch {
      setMessage(tk("Could not create the image. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function handleShare(): Promise<void> {
    try {
      await navigator.share({ title: t("FilsPay payment link"), text: t("Pay {amount}", { amount: amountLabel }), url });
      setMessage(null);
    } catch (err) {
      // Closing the share sheet is a choice, not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setMessage(tk("Sharing is not available here. Download the QR code or copy the link."));
    }
  }

  return (
    <section className="dash-qr-card" aria-labelledby="dash-qr-title">
      <div className="dash-qr-frame">
        <svg
          viewBox={`0 0 ${view} ${view}`}
          role="img"
          aria-label={t("QR code that opens the checkout page for {amount}", { amount: amountLabel })}
          shapeRendering="crispEdges"
        >
          <rect width={view} height={view} fill="#ffffff" />
          <path d={qrPath(qr)} fill="#241a1a" />
        </svg>
        <span className="dash-qr-scan" aria-hidden="true" />
      </div>

      <div className="dash-qr-body">
        <h2 id="dash-qr-title">{t("Scan to pay")}</h2>
        <p className="dash-muted">
          {t("Show or send this code. The customer points their phone camera at it and lands on the secure checkout for {amount}.", { amount: amountLabel })}
        </p>
        <div className="dash-qr-actions">
          <button type="button" className="dash-button" disabled={busy} onClick={() => void handleDownload()}>
            {busy ? t("Preparing...") : t("Download QR code")}
          </button>
          {canShare ? (
            <button type="button" className="dash-button" onClick={() => void handleShare()}>
              {t("Share link")}
            </button>
          ) : null}
        </div>
        <p className="dash-hint" role="status">{message ? t(message) : null}</p>
      </div>
    </section>
  );
}
