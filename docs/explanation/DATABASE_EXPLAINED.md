# FilsPay database explained

Database: PostgreSQL 16. Schema lives in `db/migrations/*.sql`, applied by
`db/migrate.ts` (run with `npm run migrate`, needs `DATABASE_URL`). The runner
applies files in filename order and records them in a `schema_migrations`
table that it creates itself. Each migration runs in a transaction.

Refreshed from the current migrations on 2026-10-30, after the audit fixes. The
audit added **no migration**. There are **78 migration files**, numbered up to
0083.

Notes about the migration folder:
- Numbers are not contiguous (there is no 0039, 0041, 0059, 0062, 0063, 0067)
  and there are two files numbered 0073 (`0073_adjustment_import_content_hash`
  and `0073_live_sessions_authenticated`). The runner has no checksum check
  despite a comment saying otherwise. That is harmless because the runner
  sorts by full filename, but do not assume "highest number + 1" is unique if
  two people add a migration at once.
- `LOCAL-README.md` says migrations 0054 and 0055 were edited to make local
  startup work.

---

## 1. The one rule about money

**Every money column is `BIGINT` and ends in `_fils`.** 1 BD = 1000 fils.
`amount_fils = 10000` is 10.000 BD. Rates are integer **basis points**
(`mdr_bps = 250` is 2.50 %). The older note in `CLAUDE.md` that says "cents" is
wrong; `docs/ARCHITECTURE.md` and the money package agree on fils. The branded
TypeScript type is `Fils` and Go uses `money.Fils` (`int64`). `AGENTS.md` also
says money columns are `INTEGER`: wrong, they are `BIGINT`. The one real
exception is `platform_stats.total_processed_fils`, which is `INTEGER` (see 2.1).

Fee rounding is "banker's rounding" (round half to even) done with integers
(`applyRateFils` in `packages/money`). Example: 4.750 BD at 2.50 % = 118.75 fils,
rounded to 119.

---

## 2. Table map (what each group is for)

### 2.1 Merchants and people
| Table | Key columns | Notes |
|---|---|---|
| `merchants` | `id`, `display_name`, `mdr_bps` (default 250), `status` (`active`, `suspended`, `closed`), `test_mode`, later: `onboarding_status` (`submitted`, `under_review`, `approved`, `rejected`), `kyc_passed`, negotiated discount, `refunds_enabled`, lifetime payout estimate | Root of almost everything. Only `approved` + `active` merchants can authorize payments |
| `merchant_business_profiles` | `merchant_id`, `registration_number`, legal name, contacts, address | Filled at signup / onboarding |
| `merchant_users` | `id`, `merchant_id`, `email`, `role` (`owner`, `finance`, `support`), `password_hash` | Unique per (`merchant_id`, `email`): the same email can exist under several merchants |
| `merchant_split_children` | `parent_merchant_id`, `child_merchant_id`, `split_weight_bps` | Used to split a parent's payout among child merchants |
| `fee_schedules` | `merchant_id`, `mdr_bps`, `effective_from` | Effective-dated fee rates; fall back to `merchants.mdr_bps` |
| `platform_stats` | platform-wide lifetime processed volume (`total_processed_fils`, **INTEGER / INT4**, migration 0049) | Drives the volume-tier fee bonus (15 bps off the rate once lifetime volume reaches 2,000,000.000 BD). INT4 tops out at 2,147,483,647 fils (about 2.147M BD), so the counter stops growing at about 2.147M BD of lifetime volume; the Go code saturates it at that maximum (it does not overflow or fail), and the tier threshold is below the cap, so the earned tier is never lost. Widening to BIGINT would need DBA approval (not done, low priority) |

### 2.2 Authentication
| Table | Purpose |
|---|---|
| `otp_challenges` | One row per OTP sent. Stores `code_salt` and `code_hash` (never the code), `attempt_count`, `max_attempts` (5), `expires_at`, `consumed_at`. Codes are generated with `crypto.randomInt`. A resend inherits the failed-attempt count |
| `sessions` | Merchant sessions. `token_hash` (SHA-256 of the cookie token, raw token never stored), `authenticated` (false while pending OTP), `expires_at`, `revoked_at`, ip, user agent. When `rotateSessionOnOtpVerify` is on, OTP verify replaces `token_hash` with a new token's hash |
| `api_keys` | `key_prefix` (safe to show), `key_hash` (SHA-256 of the full key), `label`, `last_used_at`, `revoked_at`. Later migrations add admin rotation and a revoke-after field |
| `admin_users` | Global unique `email`, `password_hash`, `role` (`support`, `finance`, `super_admin`), `status` (`active`, `disabled`) |
| `admin_otp_challenges`, `admin_sessions` | Same idea as merchant OTP/session tables, for admins |
| `admin_impersonation_grants` | A time-limited "view as merchant" grant: `admin_user_id`, `merchant_id`, `token_hash`, `expires_at`, `revoked_at`, `ended_at` |
| `admin_audit_log` | Who did what: `admin_user_id`, `action`, `target_type`, `target_id`, `metadata`, `outcome` (`succeeded`/`failed`). Balance adjustments now log `balance_adjustment_journaled` (older rows say `balance_adjustment`) |
| `live_sessions` | Added by migrations 0058 and 0073 (live session tracking; see those files if you need the detail) |

### 2.3 Onboarding
`kyc_documents` (file metadata and thumbnail info), `merchant_kyc_reviews`
(approve/reject records, with the reviewing admin).

### 2.4 Payments
`transactions`, `holds`, `transaction_events`, `idempotency_keys`,
`payment_links`, `refunds`, `legacy_transactions` (old imported data; see 0053).
Explained in section 3.

### 2.5 Money movements
`chart_of_accounts`, `ledger_entries` (section 4), `merchant_balances`
(cache), view `merchant_payable_position` (live sum of the ledger), plus
`credit_requests` and `adjustment_imports` / `adjustment_import_rows`
(admin corrections).

### 2.6 Settlement
`settlement_batches`, `scheme_export_lines`, `settlement_payout_disbursements`,
`settlement_batch_splits`, `settlement_paid_notification_claims` (section 5).

### 2.7 Events and webhooks
`outbox_events`, `webhook_endpoints`, `webhook_deliveries`,
`webhook_delivery_archives` (section 6).

### 2.8 Reporting read model
`merchant_daily_volume`, `merchant_payout_trends`, `reporting_outbox_cursor`,
`reporting_outbox_processed_events`, `reporting_saved_filters` (section 7).

### 2.9 Acquirer callbacks
`acquirer_callback_receipts` (dedupe), `acquirer_callback_notes`.

---

## 3. How one card payment is stored

### `transactions`
`id`, `merchant_id`, `status`, `amount_fils` (authorized amount),
`captured_fils` (running total captured), `currency` (always `BHD`), `reference`,
`acquirer_reference`, `refunded_fils` (added later), `occurred_at`.

Status values (CHECK constraint): `authorized`, `captured`,
`partially_captured`, `voided`, `refunded`, `chargeback`.
Rules in the table: `amount_fils > 0` and `0 <= captured_fils <= amount_fils`.
There is **no `declined` status**: a declined card never creates a row (the only
trace is the idempotency record).

### `holds`
Created at authorization: `transaction_id`, `amount_fils`, `status`
(`active`, `released`, `expired`), `expires_at`. Marked `released` when the
payment is fully captured or voided. `scripts/expire_holds.ts` handles expiry.

### `transaction_events`
Append-style audit trail per transaction: `event_type` (`authorized`,
`captured`, `partially_captured`, `voided`, and refund types added in 0044),
`amount_fils` (the amount **this event** moved, e.g. a capture delta),
`actor_type` (`merchant_session`, `merchant_api_key`, `system`), `actor_id`,
`metadata` (JSON, includes `feeFils` and `volumeTierBonusBps` for captures),
and `settlement_batch_id` (set when settlement claims the event).
Settlement reads **these rows**, not `transactions.captured_fils`.

### `ledger_entries`
The money record. See section 4.

### `idempotency_keys`
One row per (merchant, endpoint, key) with a request hash and the stored
response. This is how a retried `POST` returns the same answer instead of
charging twice.

### What happens, step by step

1. **Authorize** (`payments/authorize.ts`): claim idempotency key -> check
   merchant is `approved` and `active` -> call the acquirer simulator -> on
   approval insert `transactions` (`authorized`), `holds` (`active`), and a
   `transaction_events` row (`authorized`). No ledger entries yet.
2. **Capture** (`payments/capture.ts`): lock the transaction row
   (`SELECT ... FOR UPDATE`) -> validate -> call the acquirer -> compute fee ->
   update `transactions` -> insert `ledger_entries` -> release hold if fully
   captured -> `outbox_events` row `transaction.captured` -> `transaction_events`
   row. All in one database transaction.
3. **Void**: sets status `voided`, releases the hold, writes an event and a
   `transaction.voided` outbox row. No ledger entries.
4. **Settlement** later groups the capture events into a daily batch.

---

## 4. The double-entry ledger

`ledger_entries` columns: `entry_group_id`, `merchant_id`, `transaction_id`,
`settlement_batch_id`, `account_id`, `direction` (`debit`/`credit`),
`amount_fils` (always > 0), `occurred_at`, `description`.

Rules enforced **in the database**:
- A deferred constraint trigger makes sure each `entry_group_id` has total
  debits = total credits when the transaction commits (migration 0007).
- Migration 0078 makes the table **append-only**: UPDATE, DELETE and TRUNCATE
  are rejected. Fix mistakes with new, opposite entries.

Accounts (`chart_of_accounts`, `kind` is asset, liability or revenue): 
`merchant_payable` (liability: what FilsPay owes the merchant),
`platform_fee_revenue` (revenue), `card_scheme_clearing` (asset),
`platform_cash` (asset), `scheme_rounding_residue` (asset, suspense), plus
accounts added later for suspense, goodwill and manual adjustments
(migrations 0055, 0061, 0064).

### Worked example A: capture of 10.000 BD at 2.50 %

Input: `amount_fils = 10000`, merchant `mdr_bps = 250`, no schedule, no
volume bonus, no discount.

Fee = `applyRateFils(10000, 250)` = 10000 x 250 / 10000 = **250 fils** (0.250 BD).

Capture writes two balanced groups sharing one `entry_group_id`:

| # | account | direction | fils | description |
|---|---|---|---|---|
| 1 | `card_scheme_clearing` | debit | 10000 | capture: gross |
| 2 | `merchant_payable` | credit | 10000 | capture: gross |
| 3 | `merchant_payable` | debit | 250 | capture: MDR fee |
| 4 | `platform_fee_revenue` | credit | 250 | capture: MDR fee |

Check: debits = 10000 + 250 = 10250; credits = 10000 + 250 = 10250. Balanced.
The merchant is owed 10000 - 250 = **9750 fils (9.750 BD)**.

At the end of the business day the Go service closes the batch:
`gross_fils = 10000`, `fee_fils = 250`, `net_payout_fils = 9750` (fee is
recomputed per event; for this simple case it matches).
Scheme export line: 10000 is already a multiple of 10, so the scheme amount is
`10.00` and the residue is 0. No residue entries are written.

When the batch is paid (`PayoutBatch`):

| account | direction | fils |
|---|---|---|
| `merchant_payable` | debit | 9750 |
| `platform_cash` | credit | 9750 |

After this, `merchant_payable` for that capture nets to zero.

### Worked example B: the "D.DD" scheme residue

The card scheme file only carries two decimals ("D.DD", for example `4.75`),
but FilsPay stores three (fils). At batch close each export line is truncated
down to a multiple of 10 fils (`TruncateToSchemeAmount` in
`apps/settlement/internal/settlement/scheme_export.go`; the database also has
`CHECK (amount_fils % 10 = 0)` on `scheme_export_lines`).

Take a transaction captured for **4.755 BD** = `4755` fils:
- Scheme line: truncate to 4750 fils -> stored as `amount_fils = 4750`,
  `amount = 4.75`.
- Residue = 4755 - 4750 = **5 fils**.
- Ledger group written in the same transaction as the export line:

| account | direction | fils | description |
|---|---|---|---|
| `scheme_rounding_residue` | debit | 5 | scheme export rounding residue |
| `card_scheme_clearing` | credit | 5 | scheme export rounding residue |

This keeps `card_scheme_clearing` equal to what the scheme statement says
(ADR-0002). Finance clears `scheme_rounding_residue` against the scheme
statement. Only the line's residue is booked; the merchant is still paid on the
full 3-decimal figure.

### Other ledger writers
Go `recalculate_mdr.go` (fee adjustments), `splits/allocate.go` (split
payouts), API `admin/credits.ts` (approved credits, dated at Asia/Bahrain
midnight of the credit's effective date, not `now()`), and
`admin/ledgerAdjustments.ts` (`postLedgerAdjustment`, used by both the CSV
import and the single "Adjust balance" route).

**Changed in the audit:** the admin **Adjust balance** route now calls
`adjustMerchantBalanceJournaled`: it posts a balanced ledger group, updates the
cache, and writes the audit row in one transaction, so a rebuild from the ledger
keeps it. ADR-0006 and `docs/exports/admin-audit-2026-09.csv` describe the old
cache-only action `balance_adjustment`; about 25 earlier adjustments were
cache-only and are probably already lost to rebuilds (a finance decision).

**Still open (finding F-1, High):** nothing sets `refunds.settlement_batch_id`
and the payout is batch gross minus fee only, so refunds, manual credits and MDR
adjustments are not deducted from payouts. Refunds are not live, but credits are.

### `merchant_balances` is a cache
`cached_payable_fils` per merchant. Updated incrementally by settlement
(close and payout), refreshed by the Go daemon, and rebuilt on demand by
`POST /v1/admin/balances/rebuild`. The source of truth for "what is owed" is the
ledger; the view `merchant_payable_position` sums `merchant_payable` credits
minus debits live. Because the admin adjustment is now journaled, a rebuild no
longer erases it.

---

## 5. Settlement tables

| Table | Key columns | Notes |
|---|---|---|
| `settlement_batches` | `merchant_id`, `batch_date`, `status` (`open` -> `closed` -> `paid`), `gross_fils`, `fee_fils`, `net_payout_fils`, `closed_at`, `paid_at` | One batch per merchant per day: `UNIQUE (merchant_id, batch_date)`. Row-locked while closing so re-runs are safe |
| `scheme_export_lines` | `settlement_batch_id`, `transaction_id`, `amount_fils` (multiple of 10), `amount` (numeric 2 dp), `line_sequence` | The rows behind the scheme file. A later migration makes (batch, transaction) unique |
| `settlement_payout_disbursements` | `settlement_batch_id`, `amount_fils`, `disbursement_reference` | Recorded when a batch is paid; one per batch (0079) |
| `settlement_batch_splits` | `settlement_batch_id`, `child_merchant_id`, `split_weight_bps`, `allocated_fils` | Split of a parent's payout |
| `settlement_paid_notification_claims` | `settlement_batch_id` | Makes sure the `settlement.paid` outbox event is created once (migration 0082; a comment in `payout_notify.go` mentions a unique index that does not exist) |

The **business day** is midnight to midnight in **Asia/Bahrain** (UTC+3, no
daylight saving): `BusinessDayWindow` in `window.go` builds the window with
`time.LoadLocation("Asia/Bahrain")`. `CLAUDE.md` and `AGENTS.md` claim UTC
midnight; the code does not do that.

The daemon now converts the real clock to Bahrain time first
(`BusinessDayStartAt`, `dueBusinessDate`), so it closes the right day about
**15 minutes after Bahrain midnight (00:15 Bahrain)**. Before the fix the run
delay was never honoured and the real close landed near 03:00 Bahrain. Fixed in
code, covered by unit tests, not run against a live clock. `RunDailyBatch` now
settles each merchant independently: a failing merchant is logged and skipped
and the rest are still closed and paid. A permanently failing merchant is
retried every poll with no alerting.

The window selects `transaction_events` of type `captured` or
`partially_captured` with `settlement_batch_id IS NULL` and `occurred_at`
inside the day; those events are then stamped with the batch id so they can
never be settled twice.

---

## 6. Events, outbox and webhooks

### `outbox_events`
`id` (BIGSERIAL), `event_type`, `aggregate_type`, `aggregate_id`, `payload`
(JSON), `created_at`, `processed_at`. Rows are inserted **in the same database
transaction** as the thing that happened (capture, void, batch close, payout).
A trigger sends a Postgres `NOTIFY outbox_events_channel` so listeners wake up
immediately. Event types seen in code: `transaction.captured`,
`transaction.voided`, `settlement.batch_closed`, `settlement.paid`.

### `webhook_endpoints`
Merchant's receiver: `merchant_id`, `url`, `secret_ciphertext` (AES-256-GCM
encrypted with `WEBHOOK_SECRET_ENCRYPTION_KEY`), `secret_prefix` (display only),
`status` (`active`/`disabled`), who created it. Soft delete added in 0081
(`deleted_at`); deleted endpoints are hidden from lists and now return 404 on
test-send and detail.

### `webhook_deliveries`
One row per (event, endpoint): `delivery_event_id` (stable id sent to the
receiver, used for de-duplication), `payload` (exact body sent), `signature`,
`attempt_count`, `status` (`pending`, `succeeded`, `failed`, `exhausted`),
`response_status_code`, `response_body_excerpt` (first 2000 bytes),
`next_attempt_at`, `last_attempted_at`, `replay_of_delivery_id` (set on replays).
A replay inserts a **new** row with a **new** `delivery_event_id` (and the same
id inside the payload); the original row is never changed. The status `failed`
is allowed by the CHECK constraint but the dispatcher never sets it.
A unique index stops two original deliveries for the same event + endpoint.
Migration 0080 adds claim fields so two dispatcher instances do not send the
same delivery.

### `webhook_delivery_archives`
Admin tool: a saved copy of deliveries in a time range that can be replayed to
an endpoint later.

---

## 7. How `merchant_daily_volume` is built from the outbox

The reporting worker (`apps/reporting`) is a separate process. It never reads the
`transactions` table to build the numbers; it reads **outbox events**.

1. The API (capture/void) or the Go service (batch close/pay) inserts an
   `outbox_events` row inside its own transaction.
2. The reporting consumer is woken by `NOTIFY` (and polls as backup). It reads
   outbox rows of the four reporting event types that have **no marker yet** in
   `reporting_outbox_processed_events` (migration 0075), in id order, in one
   database transaction per pass. It does not rely on an id cursor, because
   BIGSERIAL ids are handed out before commit and a lower id can commit later.
   `reporting_outbox_cursor` (consumer name `reporting`) still records the
   highest id seen. Events skipped by the older cursor-based consumer, before
   0075, stay missing until a rebuild is run.
3. `applyEvent` handles each type:
   - `transaction.captured` -> upsert `merchant_daily_volume` for the merchant
     and Bahrain calendar date: `captured_count + 1`,
     `captured_gross_fils + amount`.
   - `transaction.voided` -> `voided_count + 1`.
   - `settlement.batch_closed` and `settlement.paid` -> upsert
     `merchant_payout_trends` (gross, fee, net, status, `paid_at`).
   - the columns `refund_count` / `refund_gross_fils` exist and a helper
     `applyDailySummaryRollup` can fill them, but refund events are not in the
     consumer's event list and nothing emits them. That helper buckets by UTC
     date and must be fixed before refunds are wired in.
4. `reporting_outbox_processed_events` records ids already applied (one marker per
   event) so a replay never double counts. `ON CONFLICT ... DO UPDATE` makes upserts safe to repeat.
5. Admin button `POST /v1/admin/reporting/rebuild` truncates the rollups and
   replays the outbox from the start; the result must be identical.

The merchant dashboard endpoints `GET /v1/analytics/volumes` and
`/payout-trends` read these two tables. If the reporting worker is not running,
the charts stay empty even when transactions exist.

---

## 8. Other tables, short

| Table | Purpose |
|---|---|
| `payment_links` | `token` (public, unique; `plink_` + 22 characters from `crypto.randomInt`), `amount_fils`, `status` (`active`, `reserved`, `paid`, `canceled`), `expires_at`, `reserved_at`, `transaction_id` (set when paid; CHECK ties `paid` to a transaction), creator type/id, later an attempt counter |
| `refunds` | Exists with `amount_fils`, `fee_reversed_fils`, `status` (`succeeded`/`failed`), `reason` (NOT NULL, default `'unspecified'` since 0070; the helper now sends `unspecified` for a blank reason), `acquirer_reference`, `settlement_batch_id` (nothing sets it). **No API route writes to it today** |
| `credit_requests` | Admin goodwill / dispute / correction credits; `status` `pending_approval` -> `posted` or `rejected`; `ledger_entry_group_id` set once posted. A base amount above 50,000 fils (50.000 BD) needs a second approver, and "second" is decided by admin user id |
| `adjustment_imports`, `adjustment_import_rows` | History of CSV balance adjustment uploads (raw text next to the parsed integer) |
| `reporting_saved_filters` | A merchant's saved report filters (capped at 50 per merchant, enforced under a merchant row lock) |
| `acquirer_callback_receipts`, `acquirer_callback_notes` | De-duplicate and record fraud-review callbacks |
| `legacy_transactions` | Old imported data |

Views added in 0054 and 0074 (e.g. `merchant_payable_position`) are read-only
helpers.

---

## 9. How tables connect (short version)

```
merchants 1---* merchant_users 1---* sessions
merchants 1---* api_keys
merchants 1---* transactions 1---* holds
                    |---* transaction_events (-> settlement_batch_id)
                    |---* ledger_entries (-> settlement_batch_id)
                    |---* refunds
merchants 1---* settlement_batches 1---* scheme_export_lines
merchants 1---* webhook_endpoints 1---* webhook_deliveries *---1 outbox_events
admin_users 1---* admin_sessions / admin_audit_log / admin_impersonation_grants
```

## 10. Seed data (changed in the audit)

`npm run seed` (`db/seed/index.ts`) used to fail on every database since
migration 0078, because it tried to `TRUNCATE` the append-only ledger. Now:

- It refuses unless `NODE_ENV=development` (or `SEED_ALLOW=1`) **and** the
  `DATABASE_URL` host is local (`localhost`, `127.0.0.1`, `::1`, or the compose
  service name `postgres`). The check runs before any connection.
- It inserts into an **empty** database only. If the database already has data
  it stops; `SEED_RESET=1` drops and recreates the `public` schema (destroying
  everything in that database) and re-runs migrations first.
- The audit agent ran this end to end on its own scratch database
  (migrate, seed, self-checks pass, second run refused, reset run passed).
  `LOCAL-README.md` still says the seed "resets its fixture tables"; that is
  stale. Seeded ledger descriptions are `capture <ref>`, not
  `capture: MDR fee`, so the refund helper's fee lookup would find nothing on
  seeded data.

## 11. Try it safely

Use a throwaway database, never your real one:

```bash
docker exec ops-postgres-1 psql -U filspay -d postgres -c 'CREATE DATABASE filspay_scratch'
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay_scratch?sslmode=disable'
npm run migrate
```

Useful read-only queries once you have data:

```sql
-- every ledger group must net to zero
SELECT entry_group_id,
       SUM(CASE WHEN direction='debit' THEN amount_fils ELSE -amount_fils END) AS net
  FROM ledger_entries GROUP BY 1 HAVING SUM(CASE WHEN direction='debit' THEN amount_fils ELSE -amount_fils END) <> 0;

-- what the ledger says each merchant is owed vs the cache
SELECT p.merchant_id, p.payable_fils, b.cached_payable_fils
  FROM merchant_payable_position p LEFT JOIN merchant_balances b USING (merchant_id);
```
