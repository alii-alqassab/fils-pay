import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import {
  brandLabel, caretForDigits, cvvLength, detectBrand, digitsOnly, formatExpiryInput, messageForServerField,
  newIdempotencyKey, parseExpiry, sanitizePanInput, validateAll, validateExpiry,
  type CardBrand, type FieldErrors, type FieldName,
} from "../../utils/cardValidation.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { LanguageToggle } from "../../i18n/LanguageToggle.js";
import { localeFor, tk, type Lang } from "../../i18n/translate.js";
import { FilsCard } from "./FilsCard.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse; brand: CardBrand; last4: string }
  | { kind: "declined"; message: string }
  | { kind: "terminal"; message: string };

type Values = { name: string; pan: string; expiry: string; cvv: string };
const EMPTY: Values = { name: "", pan: "", expiry: "", cvv: "" };
const FIELD_ORDER: FieldName[] = ["name", "pan", "expiry", "cvv"];

const DECLINE_TEXT: Record<string, string> = {
  insufficient_funds: tk("Your card has insufficient funds. Please use another card."),
  do_not_honor: tk("Your bank declined this payment. Please try another card or contact your bank."),
};

function formatWhen(iso: string, lang: Lang, bahrainTime: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(localeFor(lang) ?? "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bahrain" }).format(d) + ` ${bahrainTime}`;
}

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const { t, lang } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [values, setValues] = useState<Values>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [cvvFocused, setCvvFocused] = useState(false);

  // Synchronous in-flight guard: `payState` only updates on the next render, so two fast submits
  // (double click, Enter + click) could both get past a disabled button.
  const inFlight = useRef(false);
  // One idempotency key per payment attempt. After a dropped connection the SAME key is reused
  // (the server then replays the first result instead of charging twice); it is replaced when the
  // card details change or when the attempt definitively ended (declined / rejected).
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch(() => {
        // Never distinguishes "malformed token" from "doesn't exist": matches the API's non-disclosure.
        if (!cancelled) setLoadState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (loadState.kind === "loaded") document.title = t("Pay {name} · FilsPay", { name: loadState.link.merchantDisplayName });
  }, [loadState, t]);

  // Put the caret back where the customer was typing after the number was regrouped.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputs.current.pan) {
      inputs.current.pan.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const digits = digitsOnly(values.pan);
  const brand = detectBrand(digits);
  const errors = useMemo(() => validateAll(values), [values]);
  const parsedExpiry = parseExpiry(values.expiry);

  function shown(field: FieldName): string | undefined {
    if (serverErrors[field]) return serverErrors[field];
    return touched[field] || submitted ? errors[field] : undefined;
  }

  function setField(field: FieldName, value: string): void {
    setValues((v) => ({ ...v, [field]: value }));
    setServerErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
    if (payState.kind === "declined") setPayState({ kind: "idle" });
  }

  function onPanChange(e: ChangeEvent<HTMLInputElement>): void {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    const formatted = sanitizePanInput(raw);
    pendingCaret.current = caretForDigits(formatted, digitsOnly(raw.slice(0, caret)).length);
    setField("pan", formatted);
  }

  function failFrom(err: unknown): void {
    if (!(err instanceof ApiError)) {
      // Network failure or an unreadable answer: the payment may or may not have gone through.
      // Keep the attempt key: pressing Pay again replays the first result and cannot charge twice.
      setPayState({
        kind: "declined",
        message: tk("We could not confirm your payment because the connection was interrupted. Please press Pay again. You will not be charged twice."),
      });
      return;
    }
    const { statusCode, body } = err;
    if (statusCode === 400 && body.error === "invalid_card" && body.fields) {
      attempt.current = null; // never processed
      const mapped: FieldErrors = {};
      for (const [field, code] of Object.entries(body.fields)) {
        const m = messageForServerField(field, String(code));
        if (m) mapped[m.field] = m.message;
      }
      setServerErrors(mapped);
      setPayState({ kind: "declined", message: tk("Please check the highlighted card details.") });
      const first = FIELD_ORDER.find((f) => mapped[f]);
      if (first) inputs.current[first]?.focus();
      return;
    }
    if (statusCode === 402) {
      attempt.current = null; // a definitive answer: the next try is a new attempt
      const reason = typeof body.declineReason === "string" ? DECLINE_TEXT[body.declineReason] : undefined;
      setPayState({
        kind: "declined",
        message: body.stage === "capture" ? tk("Your payment could not be completed. Please try again or use another card.") : (reason ?? tk("Your card was declined. Please try another card or contact your bank.")),
      });
    } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
      setPayState({ kind: "terminal", message: tk("This invoice has already been paid.") });
    } else if (statusCode === 409 && body.error === "payment_link_canceled") {
      setPayState({ kind: "terminal", message: tk("This payment link is no longer available.") });
    } else if (statusCode === 409) {
      setPayState({ kind: "declined", message: tk("A payment is already being processed for this link. Please wait a moment, then try again.") });
    } else if (statusCode === 410) {
      setPayState({ kind: "terminal", message: tk("This payment link has expired.") });
    } else if (statusCode === 429) {
      setPayState({ kind: "declined", message: tk("Too many attempts. Please wait a minute and try again.") });
    } else if (statusCode >= 500) {
      setPayState({ kind: "declined", message: tk("We could not reach the bank just now. Please press Pay again in a moment. You will not be charged twice.") });
    } else {
      attempt.current = null;
      setPayState({ kind: "declined", message: body.message ?? tk("Something went wrong. Please try again.") });
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || inFlight.current) return;

    setSubmitted(true);
    const found = validateAll(values);
    const firstBad = FIELD_ORDER.find((f) => found[f]);
    if (firstBad) {
      inputs.current[firstBad]?.focus();
      return;
    }
    const exp = parseExpiry(values.expiry);
    if (!exp) return;

    inFlight.current = true;
    const card: SimulatedCardInput = {
      pan: digits,
      expiryMonth: exp.month,
      expiryYear: exp.year,
      cvv: values.cvv,
      cardholderName: values.name.trim().replace(/\s+/g, " "),
    };
    const fingerprint = `${digits}|${values.expiry}`;
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }
    setServerErrors({});
    setPayState({ kind: "submitting" });
    try {
      const result = await payPaymentLink(token, { card }, attempt.current.key);
      setPayState({ kind: "success", result, brand, last4: digits.slice(-4) });
    } catch (err) {
      failFrom(err);
    } finally {
      inFlight.current = false;
    }
  }

  if (loadState.kind === "loading") {
    return (
      <main className="checkout-page" aria-busy="true">
        <p>{t("Loading…")}</p>
      </main>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Payment link not found")}</h1>
        <p>{t("This payment link does not exist. Please check the address or ask the seller for a new link.")}</p>
      </main>
    );
  }

  const { link } = loadState;
  const amount = formatBhd(toFils(link.amountFils));

  if (payState.kind === "success") {
    const { result } = payState;
    return (
      <main className="checkout-page checkout-done">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Payment successful")}</h1>
        <p className="checkout-amount" dir="ltr">{amount} BHD</p>
        <p className="checkout-thanks">{t("Thank you. {name} has received your payment.", { name: link.merchantDisplayName })}</p>
        <dl className="checkout-receipt">
          <dt>{t("Paid to")}</dt>
          <dd>{link.merchantDisplayName}</dd>
          {link.reference ? (
            <>
              <dt>{t("Reference")}</dt>
              <dd>{link.reference}</dd>
            </>
          ) : null}
          <dt>{t("Card")}</dt>
          <dd>{t("{brand} ending {last4}", { brand: brandLabel(payState.brand), last4: payState.last4 })}</dd>
          <dt>{t("Date")}</dt>
          <dd>{formatWhen(result.paidAt, lang, t("(Bahrain time)"))}</dd>
          <dt>{t("Receipt no.")}</dt>
          <dd className="checkout-mono" dir="ltr">{result.transactionId}</dd>
        </dl>
        <button type="button" className="checkout-secondary" onClick={() => window.print()}>{t("Print receipt")}</button>
        <p className="checkout-help">{t("You can close this page.")}</p>
      </main>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Unable to pay")}</h1>
        <p role="alert">{t(payState.message)}</p>
      </main>
    );
  }

  if (link.status === "paid") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Already paid")}</h1>
        <p>{t("This invoice has already been paid.")}</p>
      </main>
    );
  }
  if (link.status === "expired") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Link expired")}</h1>
        <p>{t("This payment link has expired. Please ask the seller for a new one.")}</p>
      </main>
    );
  }
  if (link.status === "canceled") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("No longer available")}</h1>
        <p>{t("This payment link is no longer available.")}</p>
      </main>
    );
  }
  if (link.status === "processing") {
    return (
      <main className="checkout-page">
        <LanguageToggle className="checkout-lang" />
        <h1>{t("Payment processing")}</h1>
        <p>{t("A payment is being processed for this link. Please wait a moment and refresh.")}</p>
      </main>
    );
  }

  // link.status === 'active'
  const submitting = payState.kind === "submitting";
  const previewCard: SimulatedCardInput = {
    pan: digits,
    expiryMonth: parsedExpiry && !validateExpiry(values.expiry) ? parsedExpiry.month : Number.NaN,
    expiryYear: parsedExpiry && !validateExpiry(values.expiry) ? parsedExpiry.year : Number.NaN,
    cvv: values.cvv,
  };
  const cvvLen = cvvLength(brand);
  // A Visa/Mastercard code is exactly 3 digits and an American Express code 4; until the number
  // reveals the brand, allow up to 4 so someone who types the code first is not cut short.
  const cvvMax = brand === "unknown" ? 4 : cvvLen;

  function fieldProps(field: FieldName) {
    const message = shown(field);
    return {
      id: `card-${field}`,
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `card-${field}-error` : undefined,
      className: message ? "has-error" : undefined,
      disabled: submitting,
      ref: (el: HTMLInputElement | null) => {
        inputs.current[field] = el;
      },
      onBlur: () => setTouched((prev) => ({ ...prev, [field]: true })),
    };
  }
  const errorFor = (field: FieldName) => {
    const message = shown(field);
    return message ? (
      <span className="checkout-field-error" id={`card-${field}-error`} role="alert">
        {t(message)}
      </span>
    ) : null;
  };

  return (
    <main className="checkout-page">
      <LanguageToggle className="checkout-lang" />
      <h1>{link.merchantDisplayName}</h1>
      <p className="checkout-amount" dir="ltr">{amount} BHD</p>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">{t("Reference:")} {link.reference}</p> : null}

      {payState.kind === "declined" ? (
        <p className="checkout-error" role="alert">{t(payState.message)}</p>
      ) : null}

      <div dir="ltr">
        <FilsCard card={previewCard} brand={brand === "unknown" ? null : brand} flipped={cvvFocused} />
      </div>

      <form onSubmit={handleSubmit} className="checkout-form" noValidate aria-busy={submitting}>
        <div className="checkout-field">
          <label htmlFor="card-name">{t("Name on card")}</label>
          <input
            {...fieldProps("name")}
            name="cc-name"
            type="text"
            autoComplete="cc-name"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={60}
            value={values.name}
            onChange={(e) => setField("name", e.target.value)}
            onBlur={() => {
              setField("name", values.name.trim().replace(/\s+/g, " "));
              setTouched((prev) => ({ ...prev, name: true }));
            }}
          />
          {errorFor("name")}
        </div>

        <div className="checkout-field">
          <label htmlFor="card-pan">
            {t("Card number")}
            {brand !== "unknown" ? <span className="checkout-brand-hint">{brandLabel(brand)}</span> : null}
          </label>
          <input
            {...fieldProps("pan")}
            name="cc-number"
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            spellCheck={false}
            placeholder="1234 5678 9012 3456"
            maxLength={23}
            value={values.pan}
            onChange={onPanChange}
          />
          {errorFor("pan")}
        </div>

        <div className="checkout-form-row">
          <div className="checkout-field">
            <label htmlFor="card-expiry">{t("Expiry (MM/YY)")}</label>
            <input
              {...fieldProps("expiry")}
              name="cc-exp"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              spellCheck={false}
              placeholder="MM/YY"
              maxLength={5}
              value={values.expiry}
              onChange={(e) => setField("expiry", formatExpiryInput(e.target.value, values.expiry))}
            />
            {errorFor("expiry")}
          </div>
          <div className="checkout-field">
            <label htmlFor="card-cvv">{t("Security code")}</label>
            <input
              {...fieldProps("cvv")}
              name="cc-csc"
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              spellCheck={false}
              placeholder={"•".repeat(cvvLen)}
              maxLength={cvvMax}
              value={values.cvv}
              onChange={(e) => setField("cvv", digitsOnly(e.target.value).slice(0, cvvMax))}
              onFocus={() => setCvvFocused(true)}
              onBlur={() => {
                setCvvFocused(false);
                setTouched((prev) => ({ ...prev, cvv: true }));
              }}
            />
            {errorFor("cvv")}
          </div>
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? t("Processing…") : t("Pay {amount} BHD", { amount })}
        </button>
        <p className="checkout-secure">{t("Your card details are sent over an encrypted connection and are not stored.")}</p>
      </form>

      <p className="checkout-help">
        {t("Link valid until {when}.", { when: formatWhen(link.expiresAt, lang, t("(Bahrain time)")) })}
      </p>
    </main>
  );
}
