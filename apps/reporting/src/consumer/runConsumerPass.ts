import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

// am: refund.succeeded not here yet. when refunds ship just add it to the list
export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "settlement.paid",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, per-event completion markers, and watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events are applied with markers atomically, or (on
 * any error) neither rollups, markers, nor the watermark are committed, so
 * the next pass retries the unmarked events. BIGSERIAL ids are allocated
 * before commit and cannot reliably represent commit order; per-event
 * markers keep late-committing lower IDs eligible for a later pass.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at
         FROM outbox_events
        WHERE event_type = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM reporting_outbox_processed_events p
             WHERE p.event_id = outbox_events.id
          )
        ORDER BY id ASC
        LIMIT $2`,
      [REPORTING_EVENT_TYPES, config.consumerBatchLimit],
    );

    // FH: redundant with ORDER BY id ASC (last row is max). harmless
    let maxId = cursor.lastProcessedId;
    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
      await client.query(
        `INSERT INTO reporting_outbox_processed_events (event_id)
         VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING`,
        [rowId.toString()],
      );
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }

    return { processedCount: eventsResult.rows.length };
  });
}
