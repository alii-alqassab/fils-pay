#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export interface ResidueRow {
  merchantId: string;
  grossFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

const CORRECTION_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";
const MARCH_2026_EFFECTIVE_AT = new Date(Date.UTC(2026, 3, 1) - 1);

interface ExistingCorrectionEntry {
  entry_group_id: string;
  merchant_id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_fils: string;
  occurred_at: Date;
  description: string | null;
}

function deterministicCorrectionGroupId(merchantId: string): string {
  const hex = createHash("sha256")
    .update(`fils-pay:scheme-residue:2026-03:${merchantId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  // Format a deterministic SHA-256 prefix as a UUID with version/variant bits.
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{
    merchant_id: string;
    scheme_line_id: string;
    amount_fils: string;
    gross_fils: string | null;
  }>(
    `SELECT sb.merchant_id,
            sel.id AS scheme_line_id,
            sel.amount_fils::text AS amount_fils,
            SUM(te.amount_fils)::text AS gross_fils
       FROM scheme_export_lines sel
       JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
       LEFT JOIN transaction_events te
         ON te.settlement_batch_id = sel.settlement_batch_id
        AND te.transaction_id = sel.transaction_id
        AND te.event_type IN ('captured', 'partially_captured')
      WHERE sel.exported_at >= $1 AND sel.exported_at < $2
      GROUP BY sb.merchant_id, sel.id, sel.amount_fils
      ORDER BY sb.merchant_id, MIN(sel.exported_at), MIN(sel.line_sequence)`,
    [start.toISOString(), end.toISOString()],
  );

  return result.rows.map((row) => {
    if (row.gross_fils === null) {
      throw new Error(
        `reconcile_march: scheme export line ${row.scheme_line_id} has no batched capture events; refusing to guess its residue`,
      );
    }
    const grossFils = Number(row.gross_fils);
    const schemeFils = Number(row.amount_fils);
    const residueFils = grossFils - schemeFils;
    if (!Number.isSafeInteger(grossFils) || !Number.isSafeInteger(schemeFils) || residueFils < 0 || residueFils > 9) {
      throw new Error(
        `reconcile_march: scheme export line ${row.scheme_line_id} has inconsistent gross/export fils (${grossFils}/${schemeFils}); refusing to guess its residue`,
      );
    }
    return { merchantId: row.merchant_id, grossFils };
  });
}

/** One correction group per merchant; lineCount counts lines with residue. */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.grossFils);
    if (residue === 0) continue;
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

async function existingMarchCorrections(
  client: Client,
  merchants: MerchantResidue[],
): Promise<Set<string>> {
  const expectedByGroup = new Map(merchants.map((merchant) => [deterministicCorrectionGroupId(merchant.merchantId), merchant]));
  const result = await client.query<ExistingCorrectionEntry>(
    `SELECT entry_group_id, merchant_id, account_id, direction, amount_fils::text AS amount_fils,
            occurred_at, description
       FROM ledger_entries
      WHERE description = $1
      ORDER BY entry_group_id, id`,
    [CORRECTION_DESCRIPTION],
  );
  const byGroup = new Map<string, ExistingCorrectionEntry[]>();
  for (const row of result.rows) {
    const entries = byGroup.get(row.entry_group_id) ?? [];
    entries.push(row);
    byGroup.set(row.entry_group_id, entries);
  }

  const applied = new Set<string>();
  for (const [groupId, entries] of byGroup) {
    const expected = expectedByGroup.get(groupId);
    if (!expected) {
      throw new Error(
        `reconcile_march: prior March correction group ${groupId} exists with a non-deterministic ID; ` +
          "stop and manually reconcile its old contents before posting anything",
      );
    }

    const amount = String(expected.residueFils);
    const effectiveAt = MARCH_2026_EFFECTIVE_AT.getTime();
    const expectedLegs = new Set([
      `scheme_rounding_residue|debit|${amount}`,
      `card_scheme_clearing|credit|${amount}`,
    ]);
    const actualLegs = new Set(entries.map((entry) => `${entry.account_id}|${entry.direction}|${entry.amount_fils}`));
    const matches =
      entries.length === 2 &&
      entries.every(
        (entry) =>
          entry.merchant_id === expected.merchantId &&
          entry.description === CORRECTION_DESCRIPTION &&
          entry.occurred_at.getTime() === effectiveAt,
      ) &&
      [...expectedLegs].every((leg) => actualLegs.has(leg));
    if (!matches) {
      throw new Error(
        `reconcile_march: prior March correction group ${groupId} does not match the corrected posting; ` +
          "stop and manually reconcile its old contents before posting anything",
      );
    }
    applied.add(expected.merchantId);
  }
  return applied;
}

async function postResidueCorrection(client: Client, merchant: MerchantResidue): Promise<void> {
  if (merchant.residueFils <= 0) return;
  const entryGroupId = deterministicCorrectionGroupId(merchant.merchantId);
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'scheme_rounding_residue', 'debit',  $3, $4, $5),
            ($1, $2, 'card_scheme_clearing',    'credit', $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, MARCH_2026_EFFECTIVE_AT.toISOString(), CORRECTION_DESCRIPTION],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const runAt = new Date();

  try {
    const rows = await fetchResidueRows(client, 2026, 3);
    const merchantResidues = groupByMerchant(rows);
    const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);

    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${runAt.toISOString()}`);
    console.log(`effective date: ${MARCH_2026_EFFECTIVE_AT.toISOString()}`);
    console.log(`window: ${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // Serialize repeat invocations so deterministic group IDs cannot be
      // inserted twice by concurrent script runs.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('fils-pay:reconcile-march:2026-03', 0))`);
      const alreadyApplied = await existingMarchCorrections(client, merchantResidues);
      for (const merchant of merchantResidues) {
        if (!alreadyApplied.has(merchant.merchantId)) {
          await postResidueCorrection(client, merchant);
        }
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)${alreadyApplied.has(merchant.merchantId) ? " (already applied)" : ""}`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
