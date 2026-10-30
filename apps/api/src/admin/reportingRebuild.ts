import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // A worker pass holds this same cursor row FOR UPDATE from selection
  // through marker insertion and commit. Take it before rebuilding so a
  // worker cannot apply an event on top of rollups that this transaction is
  // replacing.
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ('reporting', 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
  );
  await client.query(
    `SELECT last_processed_id
       FROM reporting_outbox_cursor
      WHERE consumer_name = 'reporting'
      FOR UPDATE`,
  );

  // Events and their source rows are committed together. Holding SHARE on
  // outbox_events waits for in-flight inserts to finish and prevents a new
  // event from committing between the source snapshot and marker snapshot.
  await client.query(`LOCK TABLE outbox_events IN SHARE MODE`);

  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const trendResult = await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
       FROM settlement_batches`,
  );

  const volumeResult = await client.query(
    `INSERT INTO merchant_daily_volume
        (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, last_updated_at)
     SELECT t.merchant_id,
            (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
            COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')),
            COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0),
            COUNT(*) FILTER (WHERE te.event_type = 'voided'),
            now()
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE te.event_type IN ('captured', 'partially_captured', 'voided')
      GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date`,
  );

  // These rollups were rebuilt from source tables, so every currently
  // committed event handled by the reporting consumer is already reflected.
  // Mark them in this same transaction; otherwise the live worker would
  // replay its outstanding backlog on top of the rebuilt values.
  await client.query(
    `INSERT INTO reporting_outbox_processed_events (event_id)
     SELECT id
       FROM outbox_events
      WHERE event_type = ANY($1::text[])
     ON CONFLICT (event_id) DO NOTHING`,
    [["transaction.captured", "transaction.voided", "settlement.batch_closed", "settlement.paid"]],
  );

  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = GREATEST(
              last_processed_id,
              COALESCE((SELECT MAX(id) FROM outbox_events), 0)
            ),
            updated_at = now()
      WHERE consumer_name = 'reporting'`,
  );

  return { volumeRows: volumeResult.rowCount ?? 0, trendRows: trendResult.rowCount ?? 0 };
}
