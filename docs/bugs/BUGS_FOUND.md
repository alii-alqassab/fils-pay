# Every bug found: yesterday (2026-10-29) and today (2026-10-30)

This file lists every bug and problem reported in the repository's README files and in today's audit, with its **current status**. The companion file [HOW_FIXED.md](HOW_FIXED.md) explains how each one was fixed.

Sources read for this file:
- Yesterday's findings and resolutions (92 numbered findings; since merged into this folder) and the page and deployment review
- `LOCAL-README.md`, `ops/README.md`, `docs/exports/README.md`, `docs/adr/README.md`
- Today's audit: `docs/bugs/*` (discovery findings, remaining issues) and the reports of the 30 audit agents

## How to read the status column

| Status | Meaning |
|---|---|
| **FIXED (checked today)** | The fix is in the working tree and I or an audit agent read the current code today and confirmed it. Most were read-only code checks; some have a test. |
| **FIXED yesterday, not re-checked** | Yesterday's README says it was fixed. We did not look at it again today. Treat it as "claimed fixed". |
| **PARTIAL** | Part is fixed, part is still open (explained in the row). |
| **DECISION** | Needs a business, finance or security decision. A protected (locked) test may contradict the code. Nothing was changed. |
| **OPEN** | Not fixed. |
| **NOT RE-CHECKED** | Yesterday's README did not claim a fix and we could not check it today. Status unknown. |
| **STALE** | The finding no longer matches the repository. |

> **Limits of this file.** Midway through the work, macOS started refusing access to the Desktop folder (`Operation not permitted`), so findings #30, #41 and #42 could not be checked, and several other checks were cut short. Those rows say so. Nothing is marked fixed unless a README or a code check says so. No page was clicked through in a browser, and no real payment, email or webhook was sent.

---

# Part 1. Yesterday's review (2026-10-29): findings 1 to 92

Severity is shown only where yesterday's README gave one (findings 81 to 92).

## Access control and authentication

| # | Finding | Status today |
|---|---|---|
| 1 | Merchant OTP could be bypassed: a password-only (pending) session was accepted by protected routes | FIXED (checked today: `lookupSession` requires `authenticated = true`; migration `0073_live_sessions_authenticated`) |
| 2 | Login could switch merchant identities when several merchants share an email | FIXED yesterday, not re-checked. Today `/email-login` was also capped to 5 candidate businesses |
| 3 | Support admins could issue real credits | FIXED (checked today: credit routes require `finance` or `super_admin`) |
| 4 | Reports exposed other merchants' transactions through split-child scope | FIXED yesterday, not re-checked. A related question stays open: DISC-S-11 (client-supplied `filter.merchantId` honoured for split children) |
| 5 | A merchant could cancel another merchant's payment link | FIXED (checked today by the security sweep: cancel is scoped by merchant) |
| 6 | "View as merchant" grants could capture and void | FIXED (checked today: impersonation is GET-only) |
| 7 | Disabled admins kept impersonation access | FIXED yesterday, not re-checked |
| 8 | API-key rotation left the old key usable | FIXED (checked today). One protected test (`admin.test.ts:800`) still expects the old behaviour and fails: **DECISION** |
| 9 | Suspended merchants could still authorize payments | FIXED (checked today: `authorize` requires an active, approved merchant) |
| 10 | OTP attempt limit could be exceeded by parallel guesses | FIXED (re-audited today: attempts are locked and committed before the error) |
| 11 | OTP resend reset the guess budget | FIXED (re-audited today: the attempt count carries over; 30 s resend throttle) |
| 12 | Merchant cookie kept the short pending lifetime after login | FIXED (checked today: verify re-sets the cookie at the full lifetime) |

## Payments and settlement

| # | Finding | Status today |
|---|---|---|
| 13 | Payment link could charge twice after a reservation timeout | FIXED (checked today). **Today PAY-1 found two more defects in the same flow** (a silent "paid" answer when the payment was not recorded, and a silent success on a different transaction) and fixed them |
| 14 | Public callers could bypass link expiry with `submittedAt` | FIXED (checked today: ignored unless the link owner's API key is presented) |
| 15 | Capture idempotency ignored the transaction id | FIXED (checked today: request hash includes the transaction id) |
| 16 | Concurrent retries of a failed idempotency key could both proceed | FIXED yesterday, not re-checked |
| 17 | Payout arithmetic lost fils through `float32` | FIXED (checked today: integer `Fils` subtraction) |
| 18 | Split payouts did not conserve money | FIXED (the financial sweep ran the allocator today and it sums exactly) |
| 19 | Platform volume counter wrapped to negative | FIXED (checked today: it saturates at the INT4 maximum. It does **not** fail at 2.147M BD; an earlier statement of ours that it would was wrong and was corrected) |
| 20 | Scheme rounding residue was never journaled | FIXED (checked today: residue legs are posted in the same transaction as the export line) |
| 21 | Scheme-file amounts disagreed with stored fils | FIXED for new rows (checked today). Rows written before the fix are not corrected |
| 22 | Hosted checkout skipped negotiated discounts | FIXED (checked today: `pay.ts` calls the discount adjustment after capture) |
| 23 | Discount adjustment could repeat on a replay | FIXED (checked today: one adjustment per capture event, keyed by a deterministic group id). Caveat: it reads the live volume tier |
| 24 | Capture and settlement computed discounts differently | FIXED in code (checked today: the TypeScript rebate follows the Go formula). A protected test still expects the old value: **DECISION** |
| 25 | Settlement could apply a different volume tier from capture | FIXED (checked today: settlement uses the tier recorded on each capture event) |
| 26 | Go and TypeScript could pick different fee schedules | FIXED (checked today: same ordering). Residual: two rows with identical `effective_from` and `created_at` stay ambiguous |
| 27 | MDR recalculation rewrote already-paid batches | PARTIAL (checked today: paid batches are no longer touched; closed, unpaid batches are still rewritten in place) |
| 28 | MDR recalculation dropped the volume-tier discount | PARTIAL (today: it uses the current tier and plain `merchants.mdr_bps` and ignores fee schedules, so it can post spurious differences; same as F-7 below) |
| 29 | Console balance rebuild computed historical gross, not payable | FIXED (migration `0074` makes the source view read `ledger_entries`; found by the settlement agent) |
| 30 | Balance rebuilds could overwrite concurrent changes (no row lock) | NOT RE-CHECKED |
| 31 | Adjustment imports used cents instead of fils | FIXED (checked today: `6.00` BD = 6000 fils; `4.75` and `4.750` are identical). Four protected tests still assume cents: **DECISION** |
| 32 | Retrying an adjustment upload posted the money again | FIXED (checked today: content-hash dedupe, answers 409 on repeat) |
| 77 | Split payout flow may not credit child merchant balances | OPEN (an accounting question; not changed) |

## Reporting and administrative correctness

| # | Finding | Status today |
|---|---|---|
| 33 | Settlement summaries multiplied captured totals | FIXED (checked today: sums the capture events themselves, filtered by window) |
| 34 | Reconciliation compared incompatible figures | FIXED (checked today: payout debits are excluded from the ledger total so payouts are subtracted once). The reconciliation page itself was not run |
| 35 | Pending reconciliation fees ignored schedules and tier | FIXED (checked today: uses the fee recorded at capture) |
| 36 | Reporting skipped events that commit out of id order | FIXED (checked today: migration `0075` per-event markers). Events the OLD consumer skipped before the fix are not recovered until someone runs `reporting rebuild` |
| 37 | Several reporting consumers could apply the same events twice | FIXED (checked today: cursor row is locked) |
| 38 | Admin analytics rebuild double-counted the backlog | FIXED (checked today: rebuild locks the cursor and marks events processed in one transaction) |
| 39 | Payout trends stayed "closed" after payment | FIXED (checked today: `settlement.paid` is consumed). Old stale rows need a rebuild |
| 40 | A missing daily rollup stalled reporting | FIXED (checked today: it now only logs a warning; nothing alerts on that log line) |
| 41 | Status recomputation could take a sandbox merchant live | NOT RE-CHECKED |
| 42 | Status recomputation erased chargeback status | NOT RE-CHECKED |
| 43 | Bulk KYC approval bypassed state restrictions and left no review trail | PARTIAL (today's sweep saw bulk approve limited to `under_review` merchants; the missing review records were not re-checked) |
| 44 | PDF-only KYC documents could actually be images | FIXED (checked today: the rule is content-based, and a JPEG named `.pdf` is rejected by a passing test). One protected test expects a different rule: **DECISION** |
| 45 | Negative reconciliation amounts crashed the dashboard | FIXED (checked today by code reading: the formatter handles negatives) |
| 46 | `/v1/reporting/export-summary` always failed | FIXED yesterday, not re-checked |
| 47 | The displayed "current" fee schedule could be a future or superseded rate | FIXED (checked today: ordered by `effective_from <= now`). A protected test expects the opposite rule: **DECISION** |

## Webhooks and callbacks

| # | Finding | Status today |
|---|---|---|
| 48 | Outbound webhook signatures did not cover the transmitted bytes | FIXED (checked today: the signed canonical JSON is exactly what is sent) |
| 49 | Webhook URLs allowed server-side requests to private services | FIXED yesterday, not re-checked in that form. **Production protection was strengthened today** (S-6 below) |
| 50 | Production acquirer callbacks accepted missing signatures by default | FIXED (checked today: required by default in production, explicit opt-out remains) |
| 51 | Acquirer callbacks were not deduplicated | FIXED (checked today: `callback_id` primary key, migration `0077`) |
| 52 | Callback outcomes were not validated | FIXED (migration `0076` plus route validation) |
| 53 | Disabled webhook endpoints kept receiving queued deliveries | FIXED yesterday, not re-checked |
| 54 | Payout disbursement records depended on webhook deliveries | FIXED (the financial sweep confirmed a unique index prevents double payment) |
| 55 | Concurrent API replicas could attempt the same delivery | FIXED (checked today: `FOR UPDATE SKIP LOCKED` plus claim token lease) |
| 56 | Poisoned deliveries could starve the queue | FIXED (checked today: a failing row is counted and backed off; its neighbours are not blocked). One protected test disagrees on the counting rule: **DECISION** |
| 57 | Concurrent payout-notification scans created duplicate events | FIXED (checked today: migration `0082` claims table). Duplicates created before it are not removed |
| 58 | Deleting a webhook endpoint with history failed | FIXED (soft delete, migration `0081`). Today deleted endpoints also return 404 |
| 59 | Webhook responses could exhaust memory | FIXED (bounded read of 8000 bytes, kept by today's transport rewrite) |
| 79 | Inbound callback signature comparison was not constant-time | FIXED (checked today: constant-time compare) |

## Operations and database integrity

| # | Finding | Status today |
|---|---|---|
| 60 | An empty expired-hold list deleted every hold | FIXED yesterday, not re-checked. The helper is now dead code (DISC-S-20) |
| 61 | Hold cleanup deleted history and could delete released holds | FIXED (now a conditional `UPDATE` to `expired`). A related open problem: F-4 below |
| 62 | CSV exports had no date-range bound | FIXED (31-day window). A row cap is still missing (DISC-S-18) |
| 63 | Settlement daemon chose the wrong day around Bahrain midnight | **Listed as fixed yesterday but it was still broken. Fixed today (SET-1)** |
| 64 | The ledger trigger did not enforce immutability | FIXED (migration `0078`; today's sweep confirmed append-only works). The balance check is still global only (F-10 below) |
| 65 | Default development configuration could not boot | FIXED yesterday, not re-checked |
| 66 | Docker stack referenced missing Dockerfiles | STALE: both Dockerfiles exist in this commit. Images were never built, so the container path is still unverified |
| 67 | Compose did not supply the settlement internal token | STALE: compose defaults it to `dev-token`; production now refuses `dev-token` |
| 80 | Transaction CSV cells could run spreadsheet formulas | FIXED (checked today: the security sweep confirmed the escaping) |

## Parked refund helpers and manual scripts (the refund API is still a 501 stub)

| # | Finding | Status today |
|---|---|---|
| 68 | Refund helper accepted another merchant's transaction | FIXED (checked today; the helper now has a second ownership check) |
| 69 | Refund limits used authorized instead of captured money | FIXED yesterday, not re-checked |
| 70 | Concurrent refunds could over-refund | FIXED (checked today: 3 parallel refunds, exactly one succeeds) |
| 71 | A crash could strand a refund claim | FIXED yesterday, not re-checked |
| 72 | Partial refunds did not reverse the fee in total | FIXED yesterday, not re-checked (cumulative reversal) |
| 73 | Refund fee reversal ignored discounts | PARTIAL: discounts handled; volume-tier legs are not seen by the fee lookup |
| 74 | Streaming CSV helper could skip or repeat rows | FIXED yesterday, not re-checked (the helper is unused) |
| 75 | March reconciliation script used the wrong records | FIXED yesterday, not re-checked |
| 76 | March residue script posted in the wrong direction | FIXED yesterday, not re-checked |

## Added during yesterday's audit

| # | Finding | Severity | Status today |
|---|---|---|---|
| 78 | The web app had no root route | | FIXED (checked today by code reading) |
| 81 | Payment submission blocked by CORS preflight (`Idempotency-Key`) | High | FIXED yesterday, not re-checked |
| 82 | Route failures showed React Router's crash screen | Medium | FIXED (checked today by code reading: error and not-found pages exist) |
| 83 | Webhook test-send was missing in the UI | Medium | FIXED (checked today by code reading) |
| 84 | Local webhook receivers were rejected in development | Medium | FIXED yesterday, not re-checked (production still rejects private targets) |
| 85 | Payment-link retry after a timeout could miss its original transaction | High | FIXED (and improved again by PAY-1 today) |
| 86 | Transaction CSV references could execute formulas | High | FIXED (checked today) |
| 87 | Acquirer callback signatures optional by default in production | Critical | FIXED (checked today) |
| 88 | Merchant registration existed only as an API | High | FIXED (checked today by code reading: pages exist) |
| 89 | Merchant sign-in required a UUID | High | FIXED (checked today by code reading: email and password) |
| 90 | Admin reviewers could not inspect KYC documents | High | FIXED (checked today: finance and super-admin only) |
| 91 | Production CORS accepted no configured origin | High | FIXED yesterday, not re-checked |
| 92 | OTP messages were only logged | Critical | FIXED in code yesterday, not re-checked; **provider setup pending** (verified sender, `RESEND_API_KEY`, `OTP_FROM_EMAIL`) |

## Launch blockers from the deployment review

| Blocker | Status today |
|---|---|
| Live payment processing is not implemented (simulated acquirer only) | OPEN |
| Refunds are unavailable (`POST /v1/refunds` is a 501 stub; refund UI parked) | OPEN: the helper layer was repaired today, but the route, UI and webhook are not wired |
| KYC approval is not a payment gate | PARTIAL: `authorize` already requires `onboarding_status = 'approved'`, so unapproved merchants cannot take payments (checked today). They can still create links |
| The JavaScript test gate is red | PARTIAL: `apps/api` went from 24 failing of 392 to 13 failing of 506. The 13 are listed in section 2.3 |
| The full container app path is incomplete | OPEN: Dockerfiles exist, but images were never built; compose has no restart policy, limits or health checks |
| Production integrations need real-environment checks (OTP email, external webhooks, KYC upload, backups, cookies on final domains) | OPEN |

## Problems found in the other README files

| Where | Problem | Status |
|---|---|---|
| `LOCAL-README.md` | Says `./run-local.sh` starts everything. The script is not in the repository because `.gitignore` excludes every `*.sh` file | OPEN (doc) |
| `LOCAL-README.md` | Says the two Dockerfiles are missing | STALE (they exist) |
| `LOCAL-README.md`, `ops/README.md` | Say the seed truncates and regenerates its tables. That command was broken by the append-only ledger and has been rewritten (empty database only, or `SEED_RESET=1`) | FIXED in code today; **the READMEs still describe the old behaviour** |
| `ops/README.md` | States node 20 (the image uses node 22). Says the API will not boot without `WEBHOOK_SECRET_ENCRYPTION_KEY` in any environment, but its own table says a dev key is used outside production. Says `sslmode=disable` is safe because the network is private | OPEN (doc) |
| `docs/exports/README.md` | Lists `finance-adjustments-2026-08.csv`, which is not present. Snapshots are labelled production and contain staff emails and merchant ids | OPEN |
| `docs/adr/README.md` | ADR 0002 is "Accepted, implemented", but yesterday's finding #20 showed the residue was not journaled. Now true | FIXED in code |

### Count of yesterday's 92 findings

- 63 confirmed fixed by a check today (some still have a decision attached, noted in the row)
- 19 listed as fixed yesterday but not re-checked today: #2, 4, 7, 16, 46, 49, 53, 60, 65, 69, 71, 72, 74, 75, 76, 81, 84, 91, 92
- 4 partial: #27, 28, 43, 73
- 3 not re-checked: #30, 41, 42
- 2 stale: #66, 67
- 1 open: #77

---

# Part 2. Today's audit (2026-10-30)

## 2.1 The 16 issues created from your checklist

| ID | Problem | Severity | Status |
|---|---|---|---|
| PAY-1 | Payment link answered "paid" when the payment was not recorded; a different transaction also returned a silent success | High | FIXED |
| AUTH-1 | OTP codes used `Math.random()`; session token reused after OTP verification | High | PARTIAL: OTP fixed; rotation is on in production only (a setting) because it broke 66 protected tests |
| ADM-1 | Credit self-approval compared display names, not admin ids | High | FIXED |
| ADM-2 | Admin balance adjustment changed only the cache and vanished on the next rebuild | High | FIXED |
| WH-1 | Two protected dispatcher tests contradict the code (jitter, poisoned rows); wrong documentation on replay ids and the duplicate `settlement.paid` cause | Med-High | DECISION (no code change) |
| CB-1 | Callback verification hardening (empty secret, retries, check order); 3 protected tests use a 2025 timestamp | Med-High | PARTIAL (one change was reverted, see 2.4) |
| KEY-1 | Protected test expects an undocumented grace period after API-key rotation | Medium | DECISION |
| KYC-1 | KYC filename injection, missing nosniff header, no upload limits | Medium | PARTIAL (hardening fixed; one protected test expects a different rule) |
| FEE-1 | Protected test expects "most recently entered schedule wins", contradicting capture and Go | Med-High | DECISION |
| FEE-2 | Protected test expects a rebate of 2; the Go-consistent value is 3 | High | DECISION |
| REFUND-1 | Refund helper crashed on every refund without a reason | High | PARTIAL: helper fixed; the API route and UI are intentionally not wired |
| CSV-1 | Adjustment CSV: four protected tests assume 100 units per BD; reasons with commas were cut | High | DECISION for the tests; comma bug FIXED |
| SET-1 | Settlement daemon closed the wrong day and ignored its run delay; 2 stale Go ledger tests | High | PARTIAL (daemon fixed; the 2 Go tests need re-seeding) |
| RPT-1 | Reporting skipped late-committing events | Med-High | ALREADY FIXED before today (migration `0075`); regression test added |
| INFRA-1 | Production accepted dev defaults (`dev-token`, dev key, insecure cookies, no TLS, unknown `NODE_ENV`) | High | PARTIAL (config guards fixed; repository hygiene still open) |
| FE-1 | Frontend: fake progress bar, double submit, UTC date filters, unvalidated inputs, impersonation exit | Medium | PARTIAL |

## 2.2 New problems found by the discovery agents

### Security sweep (DISC-S)

| ID | Problem | Severity | Status |
|---|---|---|---|
| S-1 | A `support` session could capture and void money | High | FIXED (owner/finance for session actors) |
| S-2 | No rate limiting anywhere | High | FIXED (in-memory limiter) |
| S-3 | Public payment-link page leaked the merchant's API key hash | Med-High | FIXED (the 16-character key prefix is still returned: DECISION) |
| S-4 | A single KYC approval has no status or document precondition | Medium | DECISION |
| S-5 | CSV adjustment import has no threshold, second approver or row cap | Medium | DECISION |
| S-6 | Webhook SSRF: DNS rebinding gap, incomplete private-range list, registration vetting | Medium | FIXED (production only) |
| S-7 | Impersonating `super_admin` got merchant `owner` access | Medium | PARTIAL: role mapping FIXED; who may START impersonation is a DECISION |
| S-8 | API keys bypass every role check (a leaked key can rewrite webhook endpoints) | High | DECISION |
| S-9 | Business-profile PATCH accepted unknown keys and unvalidated values | Low-Med | FIXED (re-review after identity changes is a DECISION) |
| S-10 | Saved-filter cap did not exist | Low-Med | FIXED |
| S-11 | Client-supplied `filter.merchantId` honoured for split children | Low | OPEN (confirm intent) |
| S-12 | Framework 4xx errors became 500 | Low | FIXED |
| S-13 | Bad amounts, ids, limits, dates and cursors became 500 | Low | FIXED |
| S-14 | Deleted webhook endpoints could still be test-sent | Low | FIXED |
| S-15 | The double-charge 409 leaked another customer's transaction id | Low | FIXED |
| S-16 | No `trustProxy` setting | Low | FIXED (`TRUST_PROXY`) |
| S-17 | `/email-login` ran up to 25 password hashes per request | Low | FIXED (capped at 5) |
| S-18 | CSV export has no row cap | Low | OPEN |
| S-19 | An unset `NODE_ENV` means development (OTP returned in the response, SSRF guard off) | Low (dev) | DECISION |
| S-20 | Dead helper `scripts/lib/sqlFilter.ts` interpolates identifiers | Info | OPEN |
| S-21 | Any admin role can trigger webhook replays; KYC file reads are not audited | Info | OPEN |

### Financial-integrity sweep (DISC-F)

| ID | Problem | Severity | Status |
|---|---|---|---|
| F-1 | Refunds, credits and adjustments are never deducted from payouts (a test run overpaid by 390 BD) | High | DECISION (finance) |
| F-2 | One failing merchant stopped settlement for every merchant after it | High | FIXED |
| F-3 | Acquirer idempotency key changed on retry (possible double authorize or capture) | Medium | FIXED (not testable against a real acquirer) |
| F-4 | After a hold expires, capture still succeeds and a partial remainder can never be released | Medium | DECISION |
| F-5 | A zero amount reached the acquirer and then failed with a 500 | Medium | FIXED |
| F-6 | `npm run seed` failed on every database since the ledger became append-only; no environment guard | Medium | FIXED |
| F-7 | MDR recalculation ignores fee schedules and recorded tiers | Low-Med | DECISION |
| F-8 | Discount rebate is posted in a separate transaction after capture | Low | OPEN |
| F-9 | `idempotency_keys` are never cleaned up | Low | OPEN |
| F-10 | Balance trigger checks only the global sum; no `refunded <= captured` constraint | Low | OPEN |
| F-11 | Exports and archives in `docs/` contain staff emails, key prefixes and "prod" merchant ids | Low | OPEN (owner to confirm they are sanitised) |

### Found during integration

| ID | Problem | Severity | Status |
|---|---|---|---|
| D-1 | "View as merchant" cannot work end to end (the dashboard's `/v1/auth/me` accepts only a real merchant session). Found by code reading, not run | Medium | OPEN (decision) |
| D-2 | Reporting tests fail when run after the API tests on the same database (leftover rows from protected tests) | Low | OPEN (passes 12 of 12 on a clean database) |
| I-1 | The settlement daemon skipped payout notifications when any merchant failed, which would let one failing merchant hold back everyone's `settlement.paid` | Medium | FIXED |
| I-2 | Session rotation made 66 protected route tests return 401 | Medium | FIXED by making rotation a production-default setting (see the HOW file) |
| I-3 | Login failed at the OTP step with `no_pending_session` when the page was opened on `http://127.0.0.1:5173`: the frontends always called the API on `localhost:3000`, so the browser treated the API as another site and dropped the `SameSite=Lax` login cookie (reproduced in a clean headless Chrome) | High (blocks login) | FIXED (both frontends now call the API on the page's own host) |

## 2.3 The 13 protected tests that still fail (each contradicts the code)

| # | Test | Why it fails | What decides it |
|---|---|---|---|
| 1-3 | `admin/adjustmentImport.test.ts` lines 47, 108, 131 | Assume 100 units per BD (`6.00` = 600) | Finance approves 1000 units per BD |
| 4 | `routes/adminAdjustmentImport.test.ts:91` | Same | Same |
| 5 | `app.test.ts:274` | Expects a real PDF named `.docx` to be rejected | Keep the content-based policy, or require the extension to match |
| 6 | `fees/currentFeeScheduleDisplay.test.ts:72` | Expects "most recently entered" to win | Retire the test, or change charging (needs finance) |
| 7 | `payments/discountAdjustment.test.ts:65` | Expects rebate 2; Go gives 3 | Correct the test to 3 |
| 8-9 | `routes/acquirerCallbacks.test.ts:75,142` | Sign with timestamp 1757930000 (2025) | Use the current time in the test |
| 10 | `webhooks/inboundVerify.test.ts:20` | Same timestamp | Same |
| 11 | `routes/admin.test.ts:800` | Expects the old API key to stay valid after rotation | Retire it, or specify a grace period |
| 12 | `webhooks/dispatcher.test.ts:181` | Expects exact backoff (no jitter) | Inject jitter, or switch it off |
| 13 | `webhooks/dispatcher.test.ts:339` | Expects a poisoned row to stay at 0 attempts | Product call |

Also failing: 2 Go tests in `apps/settlement/internal/ledger` (they seed the old data shape).

## 2.4 Corrections to earlier statements of ours

| What | Correction |
|---|---|
| "The INT4 volume counter will overflow and break settlement at about 2.1M BD" | Wrong. The Go code saturates the counter; nothing fails. It only stops counting past 2.147M BD. Corrected in all documents |
| "Acquirer callback signatures should be forced on in production" (CB-1) | Reverted: it contradicts `ARCHITECTURE.md` and a committed test. The documented opt-out stays |
| "Anyone can backdate `submittedAt` on the public payment page" (PAY-1) | Wrong: the route already ignores it unless the link owner's API key is used |
| "12 refund tests failed at baseline" | 11 |
| "`run-local.sh` does not exist" | True in this checkout, but because `.gitignore` excludes `*.sh`, so it was never committed |

## 2.5 Minor findings (not counted in the totals)

1. `parsePromotionalDiscountFils` (`payments/discountAdjustment.ts:14`) uses `parseFloat` and multiplies by 100 (cents); nothing calls it. Delete it or use `parseBhdToFils`.
2. Dead fee helpers (`fees/estimate.ts`, `v1/fees/calculateFee.ts`) use floats or different rounding.
3. `apps/api/src/v1/routes/transactions.ts` contains an unauthenticated capture handler; it is not registered, so it is unreachable.
4. Payment-link creation has no amount ceiling (authorize now has one).
5. No get-one-link endpoint (the dashboard scans the newest 100).
6. Webhook status `failed` is never set; `settlement.paid` is enqueued only by the daemon and CLI (reported by the documentation agent, not independently verified).
7. KYC: parked polyglot question; orphaned files on a failed insert.
8. Admin OTP resend has no hard cap; credit reject has no requester check; no database constraint `approved_by <> requested_by`.
9. CSV import accepts `-0` as a no-op row.
10. Refund wiring risks: the acquirer is called inside the database transaction; failures are stored permanently under the idempotency key.
11. Reconciliation page is unverified (developers disagree whether the gap is always 0).
12. Unverified: the 02:00 balance refresh claim; `rebuild-balances --merchant` may not persist.
13. Unbatched events in closed windows are recoverable only by a manual `run-batch --date`.
14. Several stale code comments (listed in `docs/bugs/OPEN_ISSUES.md`, section G).

## 2.6 Repository and deployment problems

| Severity | Problem | Status |
|---|---|---|
| High | `ops/.env.docker` is tracked in git and holds a credential-like value (its comment claims it is ignored) | OPEN: untrack and rotate |
| High | `db/seed/fixtures/production_seed.sql` (15 MB, labelled "production-equivalent") is tracked and copied into every Node image | OPEN: confirm whether it is real data |
| Medium | Compose has no restart policy, limits or health checks; Postgres published with a hard-coded password; Go internal API binds all interfaces; the Node image runs `npm run dev` | OPEN |
| Medium | `db/migrate.ts` has no checksum check despite a comment; two migrations are numbered `0073`; several numbers are missing; `chargeback_cases` (reportedly on staging-2) exists nowhere in the repo | OPEN |
| Medium | Shutdown has no timeout and always exits 0 | OPEN |
| High (documentation) | `CLAUDE.md` and `AGENTS.md` say cents, UTC windows, `Math.random()` is fine for OTPs, "never use BigInt", and that a `super_admin` check protects impersonation. All are wrong | OPEN: these files were not edited |

## 2.7 Checkout (payment link page) audit

Found while making the hosted payment page behave like a real card form. All fixed; none deployed yet.

| ID | Severity | Problem |
|---|---|---|
| CK-1 | High | The API only checked that a `card` object existed. Junk numbers, expired dates and wrong CVVs reached the acquirer simulator. |
| CK-2 | High | The idempotency key was regenerated on every click, including after a dropped connection. A retry after a lost response could charge twice. |
| CK-3 | Medium | The card number was free text: no grouping, no length rule, no Luhn check, no brand detection. |
| CK-4 | Medium | Expiry was two bare number boxes with silent defaults and no "expired" check. |
| CK-5 | Medium | CVV had no length limit; letters were accepted; Amex (4 digits) and Visa (3) were not told apart. A browser test found Visa accepting 4 digits. |
| CK-6 | Medium | No "name on card" field and no `cc-*` autofill attributes, so browsers and password managers could not fill the form. |
| CK-7 | Medium | `crypto.randomUUID` does not exist on plain-http pages that are not localhost, so the Pay button crashed there. |
| CK-8 | Medium (PCI) | The CVV was part of the stored idempotency request hash. |
| CK-9 | Low | Test-card hints ("any other number approves") were shown to every customer, with no warning against entering a real card. |
| CK-10 | Low | The success page showed a raw ISO time and a UUID. No receipt, no print option, no link validity line. |

## Part 3. Website security audit (2026-10-30): findings A1 to A9

Source: [WEBSITE_SECURITY_AUDIT_2026-10-30.md](WEBSITE_SECURITY_AUDIT_2026-10-30.md). Fixed items were fixed in the working tree and re-tested; the live server has them only after the next deploy.

| ID | Severity | Problem | Status |
|---|---|---|---|
| A1 | High | Two batches of one merchant could both pass the payout balance check and overpay (reproduced: payable went to -500 fils). | **FIXED** (settlement + refunds now share a per-merchant lock). New test fails on the old code, passes now. |
| A2 | High | Production API container had no volume for KYC uploads; recreating it lost identity documents while Postgres kept the metadata. | **FIXED in config** (named volume + `KYC_UPLOAD_DIR`). Takes effect at the next deploy. Files already inside the old container were not recovered (none existed: the data was wiped). |
| A3 | High | `sharp` 0.33.5 (known high advisories) decodes uploaded images; no pixel budget, no concurrency cap. | **FIXED**: upgraded to 0.35.5, 50-megapixel limit, at most 2 decodes at a time. Per-merchant upload quotas/throttle still open. |
| A4 | High (release gate) | Refunds are enabled while finance sign-off, settlement netting, and the reporting/webhook handling of `refund.succeeded` are unresolved. | **DECISION / BLOCKED - REQUIRES DECISION.** Refunds were built and deployed at the owner's explicit request. Refund rollups and `refund.succeeded` webhooks are still not wired (intentionally left out, per the project notes). |
| A5 | Medium | Checkout rate limit keyed on the raw URL, so `%61bc`, `a%62c` and `abc` each got their own budget. | **FIXED** (canonical decoded path, plus a per-address budget). |
| A6 | Medium | Login limits reset when the email changed; `maxKeys` never bounded the limiter's memory. | **FIXED** (per-address budgets for login, admin login and checkout; the store refuses new keys when full). A shared store is still needed for several API replicas. |
| A7 | High impact, design | API keys have full merchant authority (including refunds). | **DECISION.** Not changed: needs a scopes and rotation policy. |
| A8 | Medium | Admin role `master` was missing from the impersonation role map, so its grants had no merchant role. | **PARTIAL.** Mapping fixed (master maps to view-only support). The dashboard still cannot start from an impersonation cookie, so "view as merchant" stays incomplete (D-1). |
| A9 | Medium | The transactions CSV route buffers the whole export in memory. | **OPEN.** The streaming helper exists but the route (and four locked CSV tests) were not changed. |

Dependency scan (`npm audit`): 8 packages down to 5. `sharp`, `fastify` and `fast-uri` were upgraded. Still reported: `vite`, `esbuild` and `source-map-js` (build tools, not served in production) and `react-router` / `react-router-dom` (need a major upgrade, not done).

Other items from the audit that stay open: no scheduled database backups, rotation of a formerly committed callback secret, `production_seed.sql` still tracked, one shared database role for every service, `/dashboard` payment-link detail page only searches the newest 100 links.

---

# Where the other documents are

- How each bug was fixed: [HOW_FIXED.md](HOW_FIXED.md)
- Open issues, fix details and discovery findings: this folder (`docs/bugs/`)
- Explanations of the whole project: `docs/explanation/`
