import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  payment_attempt: number;
  payment_attempt_key: string;
  reservation_token: string;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** A pay request is judged against when the buyer pressed pay, so a
 * retry that lands after midnight is not penalised. */
export function expiryReferenceTime(submittedAt?: string): Date {
  if (!submittedAt) return new Date();
  const parsed = new Date(submittedAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);
  const reservationToken = randomUUID();

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed. A timed-out claimant may still be running, so all
  // requests for one payment attempt deliberately share the same downstream
  // idempotency keys (see below).
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now(), reservation_token = $5,
            payment_attempt_key = COALESCE(payment_attempt_key, $4)
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > $3
      RETURNING id, merchant_id, amount_fils, reference, payment_attempt, payment_attempt_key, reservation_token`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime, input.idempotencyKey, reservationToken],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
    paymentAttempt: claimedRow.payment_attempt,
    paymentAttemptKey: claimedRow.payment_attempt_key,
    reservationToken: claimedRow.reservation_token,
  };

  // Step 2 — authorize.
  // The attempt counter belongs to the link, not the HTTP request. If an
  // earlier reservation times out while still running, its replacement must
  // join the same authorization instead of creating another transaction.
  // Keep attempt zero compatible with payment claims created before the
  // attempt counter was added. After a definitive decline, the attempt count
  // advances and gives the next explicit attempt a fresh idempotency scope.
  const attemptScope = link.paymentAttempt === 0 ? "" : `${link.paymentAttempt}:`;
  const authorizeKey = `paylink:${link.id}:${attemptScope}${link.paymentAttemptKey}:authorize`;
  const authResult = await releaseOnThrow(pool, link, () => authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via
    // the public link.
    actor: { type: "system" },
  }));

  if (authResult.statusCode !== 201) {
    // Only an explicit card decline ends this attempt. Keep the same key for
    // transient failures so a retry can recover the original authorization
    // result instead of starting another operation while its outcome may be
    // uncertain.
    await releaseReservation(pool, link.id, link.reservationToken, authResult.statusCode === 402);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${attemptScope}${link.paymentAttemptKey}:capture`;
  const captureResult = await releaseOnThrow(pool, link, () => captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  }));

  if (captureResult.statusCode !== 200) {
    // A definitive capture decline permits a new customer attempt. For
    // transient or validation failures, retain this attempt's key so retries
    // cannot accidentally authorize/capture a second transaction.
    await releaseReservation(pool, link.id, link.reservationToken, captureResult.statusCode === 402);
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // Negotiated discount, same step the transactions capture route runs after
  // a successful capture (capture.ts itself does not apply it). Idempotent
  // per capture event, so a replayed capture is a no-op.
  await applyCaptureDiscountAdjustment(pool, { merchantId: link.merchantId, transactionId: txnId });

  // Step 4 — finalize.
  const finalizeResult = await pool.query<{
    id: string;
    paid_at: Date;
  }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2,
            reserved_at = NULL, reservation_token = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_token = $3
      RETURNING id, paid_at`,
    [link.id, txnId, link.reservationToken],
  );

  let finalized = finalizeResult.rows[0];
  // Reachable: if authorize/capture outlasts the reservation timeout a second
  // request re-claims the link (new reservation_token). Both requests share
  // the same downstream idempotency keys, so for the same card the second one
  // replays this transaction rather than creating another. Whichever finalizes
  // first wins; the other lands here and must reconcile against the row.
  if (!finalized) {
    const current = await pool.query<{ status: string; transaction_id: string | null; paid_at: Date | null }>(
      `SELECT status, transaction_id, paid_at FROM payment_links WHERE id = $1`,
      [link.id],
    );
    const row = current.rows[0];

    if (row?.status === "paid" && row.transaction_id === txnId && row.paid_at) {
      // The other holder recorded this same transaction: idempotent success.
      finalized = { id: link.id, paid_at: row.paid_at };
    } else if (row?.status === "paid") {
      // A different transaction is recorded on a single-use link while this
      // one was also captured: a true double charge. Never answer 200.
      console.error(
        `payPaymentLink: DOUBLE CHARGE link ${link.id}: captured transaction ${txnId} but link is already ` +
          `paid with transaction ${row.transaction_id} — refund/void one of them`,
      );
      return {
        statusCode: 409,
        body: {
          error: "payment_link_double_charge",
          stage: "finalize",
          transactionId: txnId,
        },
      };
    } else if (row && (row.status === "reserved" || row.status === "active")) {
      // Our reservation was lost (e.g. a concurrent request using the same
      // keys failed and released it) but our capture succeeded: record it.
      const recovered = await pool.query<{ id: string; paid_at: Date }>(
        `UPDATE payment_links
            SET status = 'paid', paid_at = now(), transaction_id = $2,
                reserved_at = NULL, reservation_token = NULL
          WHERE id = $1 AND status IN ('reserved', 'active') AND transaction_id IS NULL
          RETURNING id, paid_at`,
        [link.id, txnId],
      );
      finalized = recovered.rows[0];
    }
  }

  if (!finalized) {
    // The capture genuinely succeeded and money moved but the link cannot
    // record it (e.g. canceled meanwhile). Surface loudly; do not tell a
    // charged customer that their payment failed.
    console.error(
      `payPaymentLink: finalize could not record captured transaction ${txnId} for link ${link.id} — ` +
        `invariant violation, investigate`,
    );
    return {
      statusCode: 200,
      body: { status: "paid", transactionId: txnId, amountFils: link.amountFils, paidAt: new Date().toISOString() },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: finalized.paid_at.toISOString(),
    },
  };
}

/**
 * authorize/capture signal some failures by throwing (e.g. 422
 * idempotency_key_reused, 409 request_in_progress). Release this request's
 * reservation (same attempt key, no advance) before rethrowing so the link is
 * not stuck 'reserved' until the timeout.
 */
async function releaseOnThrow<T>(
  pool: Pool,
  link: { id: string; reservationToken: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await releaseReservation(pool, link.id, link.reservationToken, false).catch(() => undefined);
    throw err;
  }
}

/**
 * Used by both decline branches above. Guarded by `status =
 * 'reserved' and this request's unique reservation token, so a stale request
 * cannot release a reservation reclaimed by another request.
 */
async function releaseReservation(
  pool: Pool,
  linkId: string,
  reservationToken: string,
  advanceAttempt = false,
): Promise<void> {
  await pool.query(
    `UPDATE payment_links
        SET status = 'active', reserved_at = NULL, reservation_token = NULL,
            payment_attempt = payment_attempt + CASE WHEN $2 THEN 1 ELSE 0 END,
            payment_attempt_key = CASE WHEN $2 THEN NULL ELSE payment_attempt_key END
      WHERE id = $1 AND status = 'reserved' AND reservation_token = $3`,
    [linkId, advanceAttempt, reservationToken],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
