# Remaining issues

Everything here is unresolved after the audit, with the reason and the next step.
"BLOCKED - REQUIRES DECISION" means the fix is a business, finance, security-policy or ownership choice that the audit agents were not allowed to make. Where a locked test is involved, the repo rules (`AGENTS.md`) forbid editing existing tests, so nothing was edited.

## A. Wrong tests: flagged and ignored

These tests fail on purpose. They are flagged as wrong, not edited and not satisfied: neither the test files nor the code behind them are changed for them. Treat their failures as known noise; any *other* failure is new and must be investigated.

| Verdict | Tests | Evidence |
|---|---|---|
| **Wrong (confirmed)** | CSV import: `admin/adjustmentImport.test.ts` (lines 47, 108, 131), `routes/adminAdjustmentImport.test.ts:91` | They assert `4.75` BD = 475 fils. Upstream commit `9567ea0` (2026-03-19) by the original author: "4.75 BD is 4750 fils. The test says 475. The test is wrong, but the test is scripture." ADR-0001: 1 BD = 1000 fils. |
| **Wrong (stale by the calendar)** | `routes/acquirerCallbacks.test.ts:75,142`, `webhooks/inboundVerify.test.ts:20` | Signed with timestamp `1757930000` (2025-09-15); the verifier correctly rejects anything older than 300 s. |
| **Wrong (very likely)** | `apps/settlement/internal/ledger/refresh_test.go` (2 tests) | They seed `scheme_export_lines`; migration `0074` moved the balance view to `ledger_entries`. `refresh_new_test.go` proves the code. |
| **Disputed (finance to decide)** | `fees/currentFeeScheduleDisplay.test.ts:72`, `payments/discountAdjustment.test.ts:65` | The fee test asserts "latest entered schedule wins" while capture and Go charge by `effective_from`. The rebate test asserts fee-then-discount (2 fils) while Go (the reference per `CLAUDE.md`) gives 3. Not proven wrong, so also left alone. |

Upstream (`github.com/MJ5-byte/fils-pay`) confirms none of these files was edited after it was first committed; the audit did not change them.

Detail of each (kept from the audit):

| # | Locked test | What it expects | What the code does | Evidence that the code is right | Needs from you |
|---|---|---|---|---|---|
| 1-3 | `admin/adjustmentImport.test.ts` lines 47, 108, 131 | CSV `6.00` BD becomes 600 | becomes 6000 fils | `ADR-0001` (1 BD = 1000 fils), `parseBhdToFils`, `ARCHITECTURE.md` | Finance approves rewriting the tests to 1000 units per BD |
| 4 | `routes/adminAdjustmentImport.test.ts:91` | same as above | same | same | same |
| 6 | `fees/currentFeeScheduleDisplay.test.ts:72` | the most recently ENTERED schedule wins (245 bps) | the newest `effective_from` already in effect wins (225 bps), identical to capture and the Go settlement | `feeSchedule.ts`, `fee_schedule.go`, `ARCHITECTURE.md:54-56`; `currentFeeScheduleDisplay.new.test.ts` already pins the code behaviour | Retire or correct the old test. The opposite choice would change charged fees and needs finance sign-off |
| 7 | `payments/discountAdjustment.test.ts:65` | rebate = discount applied to the fee (2 fils) | rebate = charged fee minus Go's discounted fee (3 fils) | `discounted_fee.go` and its test; Go is the reference per `CLAUDE.md`. Nine numeric cases agree with Go | Correct the test to 3 (or change Go, which the audit rejects) |
| 8-9 | `routes/acquirerCallbacks.test.ts:75,142` | accepts a callback signed with timestamp `1757930000` | rejects it (401): that timestamp is from 2025-09-15, outside the 300 s replay window | the verifier is correct; new tests with fresh timestamps pass | Change the test to sign with the current time (it passes immediately) |
| 10 | `webhooks/inboundVerify.test.ts:20` | same hard-coded timestamp | same | same | same |

Also failing but not counted above:
- **2 Go tests** in `apps/settlement/internal/ledger` (`TestRefreshBalanceCache_OverwritesDriftedCache`, `..._SumsAcrossBatches`). They seed `scheme_export_lines`, but migration `0074` made the balance view read `ledger_entries`. The code is right; `ledger/refresh_new_test.go` proves it. The old tests need re-seeding.
- **5 reporting tests** fail only when run after the API suite on the same database (D-2). On a clean database all 12 pass.

## B. Business or policy decisions needed

| Severity | Item | Why it is open | Recommended next step |
|---|---|---|---|
| **High** | **F-1 (partly fixed): refunds, credits and adjustments are not part of a batch's net payout.** A payout is now **held** (batch stays `closed`, nothing posted, a log line is written) whenever the merchant's `merchant_payable` position is below the batch net, so a merchant can no longer be overpaid. What is still open is the finance rule for *how* deductions should be netted against future payouts. | Finance decides the netting rule, then implement it in `CloseBatch`. Held batches are retried each pass. |
| **High** | **Refunds API is still 501.** The helper layer is fixed and tested (38/38), but the route, the UI (`RefundDrawer.tsx` is commented out and targets a path with no route), and the webhook are not wired. `AGENTS.md` defers `refund.succeeded` to v1.9 and an existing test asserts the 501. | Needs: the status rule after a full refund of a partial capture (`nextStatusAfterRefund` conflicts with finance's stated rule); fee reversal must account for volume-tier bonus legs (YA's note); role and scope checks on the route; F-1 above. | Finance decisions first, then wire route + `envelope.ts` case + dispatcher type + new tests. |
| **High** | **S-8 / KEY-1: API keys bypass every role check.** A leaked server key can register or change webhook endpoints (point them at an attacker URL and read all events), create/cancel payment links, and call void. | By-design "full authority" keys. | Require a session for webhook and payment-link management, or add key scopes. |
| Low | **INT4 volume counter (corrected):** `platform_stats.total_processed_fils` is an `INTEGER` column (max 2,147,483,647 fils, about 2.147M BD of lifetime volume). The Go code saturates it at that maximum instead of overflowing (`platform_volume.go`), and the tier threshold (2,000,000,000 fils) is below the cap, so settlement does not fail and the earned tier cannot be lost. The only effect is that the counter stops growing past the cap. Earlier audit text that said batch close would fail was wrong. | `AGENTS.md` says widening needs DBA approval. | Optional: DBA approves `ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;` if an accurate lifetime total is wanted (the TS reader would then need `Number()` with a safe-integer guard because `pg` returns BIGINT as a string). |
| Medium | **S-4 (partly fixed):** a single approval now requires the merchant to be `submitted` or `under_review` (409 `kyc_already_decided` otherwise). Still open: requiring uploaded documents, because locked tests approve merchants with none. | Business rule. |
| Medium | **S-5 (partly fixed):** the CSV import now caps at 1000 rows and returns 400 `unknown_merchant`. Still open: no second approver or amount threshold on imports. | Apply `creditRequiresSecondApprover` per row if finance wants it. |
| Info | **Who may start impersonation:** any admin role can, by documented design (`CLAUDE.md`): the grant is always merchant role `support`, read-only and time-limited. Not a bug. | None. |
| Medium | **D-1: "view as merchant" does not work end to end** (dashboard `/v1/auth/me` accepts only a merchant session). Code-read, not run. | Needs API and UI work. | Let `/me` accept the impersonation grant and show a read-only banner. |
| Medium | **S-19 (fixed at the entrypoint):** `apps/api/src/index.ts` now refuses to boot with `NODE_ENV` unset. `loadConfig` itself still defaults to development because locked tests call it without `NODE_ENV`. | Optional: make `loadConfig` strict once those tests set it. |
| Medium | **Callback signatures in production:** the audit agent made them mandatory; the orchestrator reverted that because `ARCHITECTURE.md:91` and a committed test document an explicit opt-out. | Documented design vs. safer default. | Owner decides; if mandatory, update the doc and test. |
| Medium | **F-7:** MDR recalculation uses `merchants.mdr_bps` and the current tier, ignoring `fee_schedules` and the recorded tier bonus; it only touches `closed` batches while the daemon pays at once. | Policy for paid batches. | Decide, then reuse `CloseBatch`'s per-event resolution. |
| Low | **Business profile (fixed):** changing the legal name or registration number of an approved merchant now sends it back to `under_review`. | Done. |
| Low | `merchantPublicKey` (16-char key prefix) is still returned on the public payment-link page because a locked test asserts it. | Locked test. | Remove it and update the test. |
| Low | **Capture/void role gate** now applies to sessions; `finance` may still void. | Confirm policy. | Confirm owner/finance for both. |

## C. Open findings with no decision needed (just work)

| Severity | ID | Item |
|---|---|---|
| Low | S-11 | Client `filter.merchantId` honoured for split-children on reporting; malformed input gives 500. Confirm intent. |
| Low | S-18 | CSV export buffers every row for a 31-day window with no cap (`AGENTS.md` says intentional). |
| Low | S-21 | Any admin role can trigger webhook replays and archives with no row cap; admin reads of KYC files are not audited. |
| Low | F-8 | The discount rebate is posted in a separate transaction after capture commits; a crash in between leaves the ledger without the rebate. |
| Low | F-10 (partly fixed) | `CHECK refunded_fils <= captured_fils` added `NOT VALID` (migration `0088`). The balance trigger still checks only the global sum, so a group can span two merchants. |
| Low | F-11 | `docs/exports` and `docs/archive` contain staff emails, key prefixes and merchant ids labelled "prod". Confirm they are sanitised. |
| Low | RPT-1 leftovers | `listener.ts` drops a NOTIFY that arrives mid-pass (latency only); `applyDailySummaryRollup` buckets by UTC (fix before refunds use it); `toUtcFromBahrain` is dead and misleading; `analytics/query.ts` treats `to` as exclusive in two widgets and inclusive in one. |
| Low | WH-1 leftovers | `replayBatch` is not idempotent on exhausted ranges; duplicate `settlement.paid` rows created before migration `0082` are not removed; a transport failure's message is not stored. |
| Low | SET-1 / W3-A leftovers | A permanently failing merchant is retried every tick with no alert or backoff; the daemon only catches up the single latest day after a long outage. |
| Low | FE-1 leftovers | Admin bulk KYC approve has no confirm dialog; payment-link detail only finds the newest 100 links; admin `/login` page not read in depth; the stale comment at `TransactionDetailPage.tsx` ~L177 says the server does not gate capture/void. |

## D. Infrastructure and repository hygiene (manual actions)

| Severity | Item | Action |
|---|---|---|
| **High** | `ops/.env.docker` was tracked in git. It is now untracked and an example file ships, but **the old value is still in git history and must be rotated**. | Rotate the callback-signing secret. |
| **High** | `db/seed/fixtures/production_seed.sql` (15 MB, header says "production-equivalent", 20 non-test merchants, 22,000 transactions) is tracked and is copied into every Node image by `COPY db`. | Confirm whether it is real data. If so, remove it from the repo and its history and from images; at minimum add `db/seed/fixtures/*.sql` to `.dockerignore`. |
| Low | Compose now has restart policies, a wait on `migrate`, an API healthcheck and a localhost-only Postgres port. Still open: resource limits; `Dockerfile.node` runs `npm run dev`; the Go internal API binds all interfaces. | Harden before any shared deployment. |
| Medium | `db/migrate.ts` has no checksum check despite a comment saying so; two migrations are numbered `0073`; numbers 0039, 0041, 0057-0059, 0062/0063, 0067 are missing; `chargeback_cases` (reportedly created on staging-2) exists nowhere in the repo. | Reconcile staging-2 before deploying there. |
| Low | API shutdown now has a 20 s timeout and exits non-zero on error. `/readyz` still never re-checks the database after the first success (documented as intentional). | Decide. |
| Low | Seeded ledger descriptions are `capture <ref>`, not `capture: MDR fee`, so the refund helper's fee lookup finds nothing on seeded data. | Fix fixtures in a separate change (changes the ledger checksum). |

## E. Documentation that is wrong (not edited by the audit)

| File | Wrong statement | Truth |
|---|---|---|
| `CLAUDE.md`, `AGENTS.md` | Amounts are cents, 1 BD = 100; `INTEGER` money columns; BD (not fils) counters | 1 BD = 1000 fils; money columns are `BIGINT` except the `platform_stats` counter (a bug, see B) |
| `CLAUDE.md`, `AGENTS.md` | Settlement windows are UTC | Asia/Bahrain (`window.go`, `ADR-0003`, locked `window_utc_compat_test.go`) |
| `CLAUDE.md`, `AGENTS.md` | `Math.random()` is fine for OTP codes | OTPs now use `crypto.randomInt` |
| `CLAUDE.md`, `AGENTS.md` | "Never introduce BigInt" | `fils.ts` uses `bigint` internally |
| `CLAUDE.md` | `/admin/impersonate` is gated by a `super_admin` middleware check | The route is `/v1/admin/merchants/:id/impersonate` with a session check only |
| `AGENTS.md` | The `v1/` route files are the live partner API | `apps/api/src/v1/routes/transactions.ts` is never registered (dead code) |
| `docs/ADMIN.md` | "None of it can break the books"; no duplicate detection on CSV import; replay reuses delivery ids; duplicate `settlement.paid` was a "retry artefact" | Balance adjustments were cache-only until this audit; duplicate detection exists (migration `0073`); replay mints a new id; the duplicates came from a scan race fixed by `0082` |
| `docs/HANDOVER.md` | Credit ledger rows post at `now()`; xid8 reporting query unmerged; impersonation maps every admin to `support` | Rows post at Bahrain midnight of the effective date; the marker-table fix shipped in `0075`; the mapping is now `support` for every role (after this audit) |
| `LOCAL-README.md` | `./run-local.sh` starts everything; Dockerfiles are missing; the seed "resets its fixture tables" | `run-local.sh` does not exist; both Dockerfiles exist; the seed needs an empty database or `SEED_RESET=1` |
| `docs/ARCHITECTURE.md` | Settlement and balance-refresh details | Not verified line by line; `settlement.batch_closed` is no longer a webhook event |

## G. Minor findings that agents reported but that were missing from the sections above

These were recorded in agent reports only. None is known to affect live traffic today unless noted.

| Severity | Area | Finding | Next step |
|---|---|---|---|
| Low | Payment links | Reported by DOC-1 from code reading (not run): the checkout and the dashboard show only what the API returns for the newest 100 links; there is no get-one-link endpoint. | Add `GET /v1/payment-links/:id`. |
| Low | Webhooks | Reported by DOC-1 from code reading: delivery status `failed` is never set (deliveries go `pending` then `exhausted` after 8 attempts), and `settlement.paid` events are enqueued only by the daemon and the CLI, not by the admin run-batch HTTP handler. Not independently verified. | Verify, then document or fix. |
| Low | KYC | The polyglot PDF/JPEG question noted in the KYC code comments is parked; stored files are orphaned if the database insert fails after the file is written. | Decide the content policy; add cleanup. |
| Low | Admin auth | OTP resend count has no hard cap (bounded by the 30 s throttle times the pending lifetime); a failed final guess does not revoke the session until the next verify or resend; credit *reject* has no requester-versus-rejecter restriction (arguably fine, it posts nothing); no database constraint `approved_by <> requested_by` as a second line of defence. | Optional hardening. |
| Low | CSV import | `-0` and `-0.000` parse to zero and are accepted as a no-op row (the frozen money parser allows it); quoted fields and embedded newlines are not supported. | Reject zero rows in the import layer. |
| Low | Refund wiring | The refund helper calls the acquirer inside the database transaction while holding the row lock (a pool connection is held for the acquirer's latency); crash-after-acquirer-accepts relies on the derived key and is untested; validation failures (409/422) and declines (402) are stored permanently under the idempotency key; the `refunds_enabled` check runs outside the lock. | Review before wiring the route. |
| Low | Reconciliation | The reconciliation page is "Not Verified": developers disagree in code comments about whether the gap is always 0. | Verify with finance's March reconciliation. |
| Low | Balances | `docs/ARCHITECTURE.md`'s statement that the cache refreshes daily at 02:00 Bahrain time was not confirmed in code; `rebuild-balances --merchant` appeared not to persist in one experiment (DISC-2, not verified). | Verify. |
| Low | Settlement | Events whose `occurred_at` falls in an already-closed window, or on a day with no batch because the merchant was suspended, stay unbatched and are recoverable only by a manual `run-batch --date`. | Add a report of unbatched events. |
| Low | Stale comments | `payout_notify.go:30` cites a unique index on `outbox_events` that does not exist; `admin.test.ts:1074` says finance and super_admin impersonation are untested; `TransactionDetailPage.tsx` ~L177 says the server does not gate capture and void (it now does for sessions); `RefundDrawer.tsx` header says it posts to `/v1/refunds` while its code targets `/v1/merchants/:id/refunds`; a comment in `processRefund.ts` about committing the claim early is stale; `routes/adminBalanceAdjustments.test.ts` has a comment that the ledger is untouched. | Fix comments when the owning files are next edited. |

## F. What was not verified

- No browser or UI automation was run, so no page was clicked through; page statuses in `ALL_PAGES_EXPLAINED.md` are "code-read, not run".
- No Docker image was built or started; only `docker compose config` was validated.
- No test was run against a real acquirer (only the simulator exists), real SMTP, or real DNS.
- Production behaviour of the SSRF pinning, rate-limit keying behind a load balancer, and session rotation could not be exercised outside unit tests.
- The agents' "failed before the fix" claims are marked as inferred wherever the old code could not be run because the working tree was shared.


## H. Decisions kept on purpose (implemented features that tests depend on)

| Item | Why it was not changed |
|---|---|
| **S-8: API keys bypass role checks, including webhook endpoint management** | Nine locked webhook tests register and manage endpoints with an API key, so this is an implemented, tested feature. Blocking it would remove a feature. If you want it closed, require a session for endpoint create/update/delete and update those tests. |
| The 13 failing API tests and 2 failing Go tests | They contradict the code, the docs or the calendar (section A). `CLAUDE.md` forbids editing existing tests. |
