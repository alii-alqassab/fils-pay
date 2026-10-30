import type { Pool } from "pg";
import { AppError, NotFoundError } from "../lib/errors.js";
import { withTransaction } from "../db/withTransaction.js";

export const ACQUIRER_CALLBACK_OUTCOMES = ["cleared", "confirmed_fraud"] as const;
export type AcquirerCallbackOutcome = (typeof ACQUIRER_CALLBACK_OUTCOMES)[number];

/** @property outcome Validated against the two allowed values by the route schema. */
export interface AcquirerCallbackInput {
  callbackId: string;
  type: "fraud_review.completed";
  transactionId: string;
  occurredAt: string;
  outcome: AcquirerCallbackOutcome;
  note: string;
}

interface TransactionMerchantRow {
  merchant_id: string;
}

/**
 * Applies one acquirer callback: looks up the transaction it refers to and
 * appends a note recording the acquirer's own delayed verdict.
 * acquirer_callback_notes is append-only and surfaced on the transaction
 * timeline for support/finance to read — a fraud-review verdict is
 * informational, not a state transition, so this never touches
 * transactions.status or the ledger; a confirmed-fraud outcome still needs
 * a human decision to void/refund, exactly as today.
 */
export async function applyAcquirerCallback(pool: Pool, callback: AcquirerCallbackInput): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Claim callbackId first. The primary key makes redelivery idempotent
    // across concurrent API replicas; the claim and note commit together.
    const claim = await client.query<{ callback_id: string }>(
      `INSERT INTO acquirer_callback_receipts (callback_id)
       VALUES ($1)
       ON CONFLICT (callback_id) DO NOTHING
       RETURNING callback_id`,
      [callback.callbackId],
    );
    if (claim.rows.length === 0) return;

    const txnResult = await client.query<TransactionMerchantRow>(
      `SELECT merchant_id FROM transactions WHERE id = $1`,
      [callback.transactionId],
    );
    const txnRow = txnResult.rows[0];
    if (!txnRow) {
      throw new NotFoundError("transaction_not_found");
    }

    await client.query(
      `INSERT INTO acquirer_callback_notes
        (transaction_id, merchant_id, callback_id, callback_type, outcome, note, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        callback.transactionId,
        txnRow.merchant_id,
        callback.callbackId,
        callback.type,
        callback.outcome,
        callback.note,
        callback.occurredAt,
      ],
    );
  });
}

/**
 * Defaults: 3 attempts, 50 ms apart.
 * — FH
 */
export interface CallbackRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

export async function withCallbackRetry<T>(fn: () => Promise<T>, options: CallbackRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 50;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Expected application errors (404, 4xx) are deterministic; retrying
      // them only delays the response. Retry unexpected (transient) errors.
      if (err instanceof AppError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}
