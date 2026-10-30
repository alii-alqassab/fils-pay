# Bug fix details

Every issue that was fixed (fully or in part) during the audit. Items that were only investigated and blocked are in `OPEN_ISSUES.md`.

How to read the "tests" lines:
- **Proved** = the new test failed on the old code and passes now (observed).
- **Inferred** = the old code could not be run (the working tree was shared, so nothing could be reverted), so "failed before" comes from reading the old code.
- All new tests are in new files named `*.new.test.ts` or `*_new_test.go`. No existing test file was edited.
- Full-suite results: `apps/api` 506 tests, 493 pass, 13 fail (the 13 are locked-test conflicts, see `OPEN_ISSUES.md`); Go all packages ok except 2 stale `internal/ledger` tests.

---

### PAY-1 — Payment link could report "paid" when the payment was not recorded
**What was wrong?** In `payPaymentLink`, a second request could re-claim a link whose reservation had timed out. If the second request used a different card, its authorize call threw a 422 without releasing the reservation, and the first request's final "mark paid" UPDATE matched 0 rows. The first request still answered **200 "paid"**, but the link stayed unpaid with no transaction recorded. A finalize that found a *different* transaction also returned a silent 200.
**Why did it happen?** The code assumed a 0-row finalize was "unreachable" (comments by two engineers disagreed) and never re-read the link; exceptions from authorize/capture skipped the release step.
**How could it affect users?** A customer could be charged while the link looked unpaid and payable again, and a real double charge would have been reported as success. (A double charge through the *same-card* path does **not** happen: both requests reuse the same idempotency keys and replay one transaction. A test proves it.)
**Which files were modified?** `apps/api/src/paymentLinks/pay.ts`; new `pay.new.test.ts`.
**What exactly was changed?** A 0-row finalize now re-reads the link: same transaction means an idempotent 200; a different transaction logs `DOUBLE CHARGE` and returns **409 `payment_link_double_charge`**; unpaid with no transaction is finalized by id. A throw inside authorize/capture releases this request's reservation (token-guarded) and rethrows. The 409 body no longer includes the other customer's transaction id (S-15).
**What tests prove the fix?** `pay.new.test.ts` (3 tests, real Postgres, slow acquirer stub): the different-card and different-transaction cases **failed before, pass after (proved)**; the same-card case passes before and after and shows exactly one `transactions` row. 16/16 with the neighbouring payment-link suites.
**Is it fully fixed?** Yes for the defects found. Operationally, someone must still void or refund one of two transactions if the 409 ever fires (no automation). The related `submittedAt` concern was already fixed before the audit (`routes/paymentLinks.ts` ignores it unless the link owner's API key is presented).

### AUTH-1a — OTP codes (and link slugs) were generated with `Math.random()`
**What was wrong?** `randomDigits` and `randomFromAlphabet` used `Math.random()`, a predictable generator, for the login second factor (merchant and admin) and for payment-link slugs and display references.
**Why did it happen?** `CLAUDE.md`/`AGENTS.md` said it was acceptable for non-bearer tokens.
**How could it affect users?** In principle OTP codes could be guessed from observed output.
**Which files were modified?** `apps/api/src/lib/random.ts`; new `auth/otpSessionRotation.new.test.ts`.
**What exactly was changed?** Both functions now draw each character with `crypto.randomInt`. Signatures and output format (uniform, zero-padded, same length) are unchanged.
**What tests prove the fix?** A test with `Math.random` stubbed to throw: failed with the fix reverted, passes now (**proved**). 20/20 neighbouring tests (`auth/otp`, `auth/sessions`, `routes/paymentLinks`).
**Is it fully fixed?** Yes. The verify attempt budget, resend throttle and exhaustion handling were already adequate and were not changed.

### AUTH-1c — Session token was reused after OTP verification (session fixation)
**What was wrong?** At OTP verify the server promoted the pending session but kept the same token as the authenticated cookie (merchant and admin).
**Why did it happen?** `promoteSession` only flips a flag and never replaces the token hash.
**How could it affect users?** A pending cookie that leaked before OTP success would become fully authenticated. (Exploitation needs the attacker to obtain the pending cookie; tokens are server-generated, so classic fixation is limited.)
**Which files were modified?** `auth/sessions.ts`, `adminAuth/sessions.ts`, `routes/auth.ts`, `routes/adminAuth.ts`, `config.ts`, `auth/otpSessionRotation.new.test.ts`.
**What exactly was changed?** New `rotateSessionToken` / `rotateAdminSessionToken` write a fresh token hash inside the verify transaction, and the cookie is set to the new token. **Orchestrator change:** because rotation made 66 locked route tests return 401 (they reuse the pre-verify cookie), rotation is controlled by `ROTATE_SESSION_ON_OTP_VERIFY` which **defaults to ON in production and OFF elsewhere**.
**What tests prove the fix?** `otpSessionRotation.new.test.ts` (with the setting enabled): old pending token stops working, new token works, for merchant and admin; all failed with the fix reverted (**proved**).
**Is it fully fixed?** Partly. Production gets rotation by default, but the locked suites do not exercise it (they run with it off). To get full coverage the locked tests' `signedInAdmin` helpers must use the cookie from the verify response.

### ADM-1 — Credit approval compared display names, not admin ids
**What was wrong?** `assertDistinctApprover` blocked self-approval only when `displayName` matched.
**Why did it happen?** The check was written against the audit-log label; `HANDOVER.md` says ids.
**How could it affect users?** One person with two accounts, or who renamed their display name, could approve their own credit above 50.000 BD; two different admins sharing a display name were wrongly blocked.
**Which files were modified?** `apps/api/src/admin/creditApproval.ts`; new `creditApproval.new.test.ts`.
**What exactly was changed?** The check now throws `self_approval_forbidden` when the admin user ids are equal; the display-name comparison was removed.
**What tests prove the fix?** `creditApproval.new.test.ts` (3 tests incl. a DB flow: renamed requester cannot self-approve, same-name distinct admin can approve, second approval gets 409). 3/3, plus `creditApproval` 2/2, `credits` 9/9, `creditThreshold` 8/8. "Failed before" is **inferred**.
**Is it fully fixed?** Yes at application level. No database-level constraint (`approved_by <> requested_by`) was added.

### ADM-2 — Admin "Adjust balance" was cache-only and disappeared on the next rebuild
**What was wrong?** The route updated only `merchant_balances.cached_payable_fils`, writing no ledger entries. The 02:00 rebuild and the console "Rebuild cached balances" recompute the cache from the ledger, so the adjustment vanished.
**Why did it happen?** The route was wired to `applyBalanceCorrection`; the journaled variant `adjustMerchantBalanceJournaled` existed but was unused.
**How could it affect users?** A finance adjustment looked right, then silently reverted, leaving the merchant's payable wrong again. About 25 earlier adjustments in the September audit export were probably lost this way.
**Which files were modified?** `routes/adminBalanceAdjustments.ts`; new `routes/adminBalanceAdjustments.new.test.ts`.
**What exactly was changed?** The route now calls the journaled function (balanced ledger legs + cache update in one transaction). Overflowing deltas or results return 400 (were 500). Response shape unchanged. The audit action is now `balance_adjustment_journaled`.
**What tests prove the fix?** 4 new tests (adjustment survives a rebuild using the same SQL as `RebuildMerchantBalance`; overflow cases): **all 4 failed before, pass after (proved)**. `admin/balanceAdjustments.test.ts` passes.
**Is it fully fixed?** Yes going forward. Past cache-only adjustments are not reconciled (finance decision); audit consumers must treat both action names as one event type (`ADR-0006`, September CSV export).

### REFUND-1 — Refund helper crashed on every refund without a reason
**What was wrong?** `processRefund` sent an explicit NULL `reason`, which bypasses the column default `'unspecified'` and violates `chk_refunds_reason_not_null` (migration 0070). 11 locked tests failed.
**Why did it happen?** The insert was written before migration 0070.
**How could it affect users?** None live, because `POST /v1/refunds` is still a 501 stub.
**Which files were modified?** `payments/processRefund.ts`; new `payments/processRefund.new.test.ts`.
**What exactly was changed?** A blank or missing reason becomes `"unspecified"` (trimmed); and the helper now checks inside the locked read that the transaction belongs to the calling merchant (404 and no writes otherwise).
**What tests prove the fix?** 4 new tests (3 failed with the fix reverted — **proved**); with the 11 previously failing locked tests, 38/38 pass.
**Is it fully fixed?** Only the helper. The refund API route, UI and webhook are intentionally not wired (see `OPEN_ISSUES.md` B).

### SET-1 — Settlement daemon closed the wrong day and ignored its run delay
**What was wrong?** The daemon passed a raw UTC instant into the date-only `BusinessDayWindow`. Between 00:00 and 03:00 Bahrain it targeted the previous day again, and the configured delay was never honoured (a restart at 00:05 closed immediately; the real close landed around 03:00).
**Why did it happen?** `time.Now().UTC()` fed to a function that reads only the calendar date.
**How could it affect users?** Daily payouts and `settlement.paid` notifications at the wrong time; early close on restart.
**Which files were modified?** `settlement/window.go` (adds `BusinessDayStartAt`), `scheduler/daemon.go`; new `scheduler/daemon_new_test.go`, `ledger/refresh_new_test.go`.
**What exactly was changed?** New `BusinessDayStartAt` converts an instant to Bahrain first; a pure `dueBusinessDate` honours the delay on boot and on every tick. `BusinessDayWindow` itself is unchanged (its CLI and API callers pass date-only values and were never affected).
**What tests prove the fix?** `TestDueBusinessDate_HonoursRunDelayInBahrainTime` failed before (3 failures), passes now (**proved**).
**Is it fully fixed?** Yes for the daemon. **Behaviour change:** the daily close now starts at Bahrain 00:15 (was effectively ~03:00). Two stale `internal/ledger` tests remain failing (they seed the old data shape).

### CB-1 — Acquirer callback verification hardening
**What was wrong?** An empty signing secret accepted forgeable signatures and unsigned requests; a deterministic 404 was retried three times; field validation ran before authentication.
**Why did it happen?** Dev-friendly shortcuts. (The 3 failing locked tests are *not* a verifier bug: they sign with a 2025 timestamp outside the 300 s window.)
**How could it affect users?** Forged fraud-review notes could be posted in misconfigured environments; probing of validation behaviour without credentials.
**Which files were modified?** `webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`, `acquirer/callbacks.ts`; new `inboundVerify.new.test.ts`, `routes/acquirerCallbacks.new.test.ts`.
**What exactly was changed?** An empty secret never validates a present header or a required signature; AppErrors are rethrown immediately instead of retried; the signature is checked before the body is validated. (A fourth change, forcing signatures on in production, was reverted by the orchestrator because it contradicts `ARCHITECTURE.md:91` and a committed test.)
**What tests prove the fix?** 5/5 and 4/4 new tests pass. "Failed before" for the four hardening tests is **inferred**.
**Is it fully fixed?** Partly: the replay protection and verifier were already correct; the signature is still computed over `JSON.stringify(parsed body)`, not raw bytes (confirm with the acquirer).

### KYC-1 — KYC upload filename and header hardening
**What was wrong?** The stored `file_name` was unsanitised and echoed into `Content-Disposition`, allowing quote or header injection; no `nosniff` header; no multipart `files`/`fields` limits.
**Why did it happen?** The filename was treated as informational but still reflected back.
**How could it affect users?** A crafted filename could mislead a reviewer or inject into a response header.
**Which files were modified?** `onboarding/kyc.ts`, `routes/kyc.ts`, `plugins/multipart.ts`; new `onboarding/kycFileName.new.test.ts`.
**What exactly was changed?** `sanitizeFileName` (strips path parts, control characters, quotes, backslash, semicolon; max 200; fallback "document") applied on write and on read; `X-Content-Type-Options: nosniff` on served documents; multipart limited to `files: 1, fields: 10`.
**What tests prove the fix?** One new test file (4 assertions) and 14/14 onboarding tests. Route changes (header, limits) are **not covered end to end**.
**Is it fully fixed?** The hardening is in. The locked `app.test.ts:274` still fails: it expects the extension to matter, which contradicts the documented magic-byte policy (decision pending).

### INFRA-1 — Production could start with development defaults
**What was wrong?** Production accepted `SETTLEMENT_INTERNAL_TOKEN=dev-token`, the built-in dev webhook key, `COOKIE_SECURE=false`, `OTP_DEV_EXPOSE=true`, `sslmode=disable`, and any unknown `NODE_ENV` silently became development.
**Why did it happen?** Production checks tested only that a value was present.
**How could it affect users?** A production deploy with `dev-token` or the dev key would be forgeable; a `NODE_ENV` typo would expose OTPs and drop Secure cookies.
**Which files were modified?** `apps/api/src/config.ts`, `apps/settlement/internal/config/config.go`; new `config.prodGuards.new.test.ts`, `config_devtoken_new_test.go`.
**What exactly was changed?** In production the API refuses to start with any of those values (explicit opt-out `DATABASE_ALLOW_NO_TLS=true` for private networks); an unrecognised non-empty `NODE_ENV` throws; the Go service rejects `dev-token` in production.
**What tests prove the fix?** 7 new TS tests and the Go config tests pass. The six production-guard tests could not have passed before (guards did not exist).
**Is it fully fixed?** The config guards, yes. Still open: tracked `ops/.env.docker`, `production_seed.sql`, compose hardening, unset `NODE_ENV` (see `OPEN_ISSUES.md`). **Risk:** a staging deployment that relies on the old defaults will now fail to start.

### CSV-1 — CSV import dropped everything after the 3rd comma in a reason
**What was wrong?** The hand-rolled splitter saved a reason like `fix, again` as `fix`.
**Why did it happen?** Only the first three cells were read.
**How could it affect users?** Lost audit context on adjustments.
**Which files were modified?** `admin/adjustmentCsvParsing.ts`; new `adjustmentCsvParsing.new.test.ts`.
**What exactly was changed?** Remaining cells are rejoined into the reason (spacing preserved).
**What tests prove the fix?** 5/5 new tests; the comma test **failed before (proved)**. The new file also pins `6.00` BD = 6000 fils and rejection of `1.2345`, `1e3`, empty and garbage.
**Is it fully fixed?** The comma bug yes. The four locked tests that assume 100 units per BD still fail (decision pending), and the DB-backed import tests were not re-run by this agent (they were in the orchestrator's full run).

### FE-1 — Frontend fixes
**What was wrong?** A float-math "progress bar" on the settlement batch page; double-submit relied on a disabled button; capture amount used `Number()` on free text; the transaction date filter used UTC midnight while settlement days are Bahrain; admin default dates used the browser timezone; the balance delta accepted `1e3`/`0x10`; support users saw an error on onboarding; impersonation exit cleared the banner even when the end call failed.
**Why did it happen?** Mixed unit and timezone assumptions; client-side validation gaps.
**How could it affect users?** Wrong day filters, duplicate charge attempts, mistyped adjustments, a live impersonation grant left behind.
**Which files were modified?** Web: `SettlementBatchDetailPage.tsx`, `CheckoutPage.tsx`, `TransactionDetailPage.tsx`, `TransactionListPage.tsx`, `format.ts`, `OnboardingPage.tsx`. Admin: `AdminAuthContext.tsx`, `SettlementPage.tsx`, `MerchantDetailPage.tsx`, new `dates.ts`. New tests: `format.bahrain.new.test.ts`, `adminDates.new.test.ts`.
**What exactly was changed?** Removed the bar; a synchronous in-flight guard on checkout and no client `submittedAt`; whole-fils validation; `bahrainDayStartIso`; `bahrainDate()`; digits-only balance delta; support role skips the KYC list; impersonation exit keeps the banner on failure.
**What tests prove the fix?** Builds and typecheck pass; `apps/web` 15/15. The new tests cover only the new helper functions; the UI behaviour changes have **no automated or live-browser coverage**.
**Is it fully fixed?** The listed defects yes (code level). Capture/void role mismatch, checkout idempotency-key reuse and bulk-approve confirmation remain open.

### W2-A — `support` could capture or void money; malformed input caused 500s
**What was wrong?** Capture and void required only a logged-in merchant actor, so a read-only `support` session could move money. Non-integer or negative amounts, `limit=abc`, non-UUID ids, bad dates and tampered cursors reached Postgres and produced 500s. Amount 0 reached the acquirer.
**Why did it happen?** No role gate on those two routes (a TODO asked for one); no input validation at the boundary.
**How could it affect users?** Unauthorized captures and voids; noisy errors; orphan authorizations with a real acquirer.
**Which files were modified?** `routes/transactions.ts`, `routes/paymentLinks.ts`, `routes/settlement.ts`, `transactions/query.ts`, `paymentLinks/query.ts`, `settlement/query.ts`; new `lib/queryParams.ts`, `routes/transactionsHardening.new.test.ts`.
**What exactly was changed?** Capture and void require merchant role owner or finance for session actors (API keys still pass). Authorize requires `0 < amountFils <= 99,999,999,990`. Invalid ids give 404, bad dates/cursors 400, `limit=abc` falls back to the default.
**What tests prove the fix?** 7 new tests; with the diff reverted 4 of the first 6 failed (**proved**); the amount-bound test was not run against old code. 53/53 neighbouring tests passed.
**Is it fully fixed?** Yes for sessions. API keys are not role-limited (open, S-8). Behaviour change: a malformed cursor now returns 400 (it used to restart at page 1).

### W2-B — Public payment-link page leaked an API key hash and another customer's transaction id
**What was wrong?** `GET /v1/payment-links/:token` (no login) returned the merchant's latest active API key hash as `merchantIntegrationId`; the double-charge 409 returned another transaction's id.
**Why did it happen?** The DTO joined the `api_keys` row; the comment claimed nothing authenticating was exposed.
**How could it affect users?** Credential-derived material exposed to anyone holding a link.
**Which files were modified?** `paymentLinks/read.ts`, `paymentLinks/pay.ts`, `pay.new.test.ts`; new `read.new.test.ts`.
**What exactly was changed?** `merchantIntegrationId` is now the merchant id (same field name); `linkTransactionId` removed from the 409 body (still logged).
**What tests prove the fix?** `read.new.test.ts` failed on the old query and passes (**proved**); 16/16 neighbouring tests.
**Is it fully fixed?** Mostly: the 16-character key prefix (`merchantPublicKey`) is still returned because a locked test asserts it.

### W2-C — Webhook SSRF gaps and deleted endpoints still usable
**What was wrong?** The SSRF check resolved the hostname and `fetch` resolved it again (DNS rebinding), registration vetted only literal IPs, the private-range blocklist missed several ranges (NAT64, 6to4, `192.0.0.0/24`, `198.18.0.0/15`), and deleted endpoints could still be test-sent and listed.
**Why did it happen?** Check and connection were two separate lookups; incomplete blocklist; two queries ignored `deleted_at`.
**How could it affect users?** In production a merchant could aim webhooks or test-sends at internal or cloud-metadata addresses.
**Which files were modified?** `webhooks/transport.ts`, `create.ts`, `update.ts`, `testSend.ts`, `list.ts`; new `ssrfBlocklist.new.test.ts`, `softDelete.new.test.ts`.
**What exactly was changed?** The transport uses `node:http`/`https` with a custom `lookup` that returns only vetted public addresses (Host/SNI unchanged, redirects refused, 8000-byte body cap); registration resolves names and rejects private results (DNS failure not fatal); the blocklist parses IPv6 into 8 groups and fails closed; deleted endpoints return 404.
**What tests prove the fix?** 44 pure unit tests plus a DB test; 88 of 90 combined tests pass (the 2 failures are the locked dispatcher tests). "Failed before" is **inferred**.
**Is it fully fixed?** In production mode, yes by design. **All guards run only when `NODE_ENV=production`**, so an unset `NODE_ENV` has no SSRF guard (S-19 open). Pinning was not exercised against real public DNS.

### W2-D — Business-profile PATCH, saved filters and framework errors
**What was wrong?** PATCH bodies with unknown or inherited keys (`constructor`) produced 500s and values were unvalidated; saved filters had no cap (the cited constraint did not exist); malformed JSON, wrong content type and oversize bodies became 500s.
**Why did it happen?** Column map indexed by raw user keys; unbounded insert; no handler branch for Fastify 4xx errors.
**How could it affect users?** Garbage or null written to profile columns; unbounded storage; misleading error codes.
**Which files were modified?** `onboarding/businessProfile.ts`, `reporting/savedFilters.ts`, `plugins/errorHandler.ts`, `routes/reporting.ts`; new `routes/w2dRegressions.new.test.ts`.
**What exactly was changed?** `Object.hasOwn` whitelist plus value validation (400s); saved filters capped at 50 per merchant under a row lock (409), name 100 chars, filter 8 KB; framework 4xx errors keep their status.
**What tests prove the fix?** 4/4 new tests including 60 concurrent creates giving exactly 50 x 201 and 10 x 409; neighbours 21/21. "Failed before" is **inferred**.
**Is it fully fixed?** Yes. Not done (decision): re-review after identity-field edits following KYC approval. Risk: a client sending extra PATCH fields now gets 400.

### W2-E — No rate limiting; unbounded login cost; no proxy trust setting
**What was wrong?** No throttling anywhere (password guessing, OTP-email flooding, card testing on the public pay endpoint, signup flooding); `/email-login` ran up to 25 argon2 verifies per request; `trustProxy` was not configurable.
**Why did it happen?** Never implemented.
**How could it affect users?** Account guessing, CPU exhaustion, email spam to victims, card testing.
**Which files were modified?** New `lib/rateLimit.ts`, `rateLimit.new.test.ts`; `app.ts`, `config.ts`, `routes/auth.ts`.
**What exactly was changed?** An in-memory fixed-window limiter wired as one app-level hook (no new npm dependency): login 10/min per IP+email, OTP 10/min per IP, admin login 10/min, public pay 20/min per IP+token, signup 10/hour per IP; 429 `rate_limited` with `Retry-After`; off when `NODE_ENV=test` unless `RATE_LIMIT_ENABLED=true`; `TRUST_PROXY` setting; email-login candidates capped at 5.
**What tests prove the fix?** 6/6 new tests. "Failed before" is **inferred** (no limiter existed).
**Is it fully fixed?** In code, yes. **Manual action:** set `TRUST_PROXY` behind a load balancer, or every client shares one IP. The store is per process; several replicas need a shared store.

### W2-F — Impersonation over-granted merchant roles
**What was wrong?** "View as merchant" mapped `finance` to merchant `finance` and `super_admin` to merchant `owner`, although the docs say always read-only `support`.
**Why did it happen?** The role map widened to match the admin role.
**How could it affect users?** An impersonating admin could read webhook endpoints and delivery payloads that `support` cannot.
**Which files were modified?** `admin/impersonation.ts`; new `impersonationRole.new.test.ts`.
**What exactly was changed?** All three admin roles now map to `support`.
**What tests prove the fix?** 3/3 new tests; the `finance` case failed with the old mapping restored (**proved**; the `super_admin` case was not run against the old mapping).
**Is it fully fixed?** The mapping yes. Any admin role can still start impersonation (decision), and the merchant dashboard cannot actually use a grant (D-1).

### W3-A — One failing merchant blocked settlement for everyone after it
**What was wrong?** `RunDailyBatch` returned on the first error; a merchant whose batch could not close (e.g. a capture so large that the scheme amount overflowed `NUMERIC(10,2)`) left every later merchant unsettled, and the daemon retried the same failure forever.
**Why did it happen?** Early return in the per-merchant loop.
**How could it affect users?** Merchants were not paid.
**Which files were modified?** `settlement/batch.go`, `internalapi/server.go`, `cmd/settlement/main.go`; new `run_daily_batch_new_test.go`.
**What exactly was changed?** Each merchant is settled independently; failures are logged, collected and returned as a typed `BatchFailuresError` at the end; the CLI exits non-zero; the internal API answers HTTP 500 `run_batch_partial_failure` with a `failedMerchants` list (success shape unchanged).
**What tests prove the fix?** `TestRunDailyBatch_FailureIsolatedPerMerchant` failed with the old early return (mutation, restored) and passes (**proved**). `go vet` clean.
**Is it fully fixed?** Yes for isolation. A follow-up by the orchestrator changed `scheduler/daemon.go` so the daemon still enqueues `settlement.paid` notifications after a partial failure (it used to return before that step, which would have let one failing merchant hold back everyone's notifications). No alerting or backoff for a permanently failing merchant. **Behaviour change:** the admin UI shows an error even when other merchants were settled.

### W3-B — Acquirer idempotency key changed on retry; zero amount reached the acquirer
**What was wrong?** The key sent to the acquirer for authorize and capture was `claimRowId:attemptCount`, which changes after an ambiguous error or rollback, so a retry could authorize or capture twice if the first call had actually succeeded. Amount 0 or negative was approved by the acquirer and then failed a database check with a 500.
**Why did it happen?** The key was tied to the database claim row, not to the caller's durable idempotency scope (refunds already used the right approach).
**How could it affect users?** Possible double authorization or capture with a real acquirer; orphan authorizations.
**Which files were modified?** `payments/authorize.ts`, `payments/capture.ts`, `acquirer/simulator.ts`; new `payments/authorizeCapture.new.test.ts`.
**What exactly was changed?** The key is derived from merchant + endpoint + client key + request hash. Authorize rejects non-positive amounts (422 `invalid_amount`) before the claim and acquirer call. The simulator no longer caches `error` outcomes (otherwise a stable key would replay the error forever).
**What tests prove the fix?** 3 new tests (recording fake acquirer: identical key on retry, different key for a different client key; zero/negative never reach the acquirer); 10/10 acquirer tests pass. "Failed before" is **inferred**.
**Is it fully fixed?** In code, yes. Behaviour against a real acquirer could not be tested (only a simulator exists).

### W3-C — `npm run seed` was broken and unguarded
**What was wrong?** The seed ran `TRUNCATE ... CASCADE`, which migration 0078 forbids on the append-only ledger, so the documented demo-data command failed on every database; it also had no environment or host guard.
**Why did it happen?** The seed predates the append-only trigger.
**How could it affect users?** Developers could not load demo data; a wrong `DATABASE_URL` could have wiped a shared database.
**Which files were modified?** `db/seed/generate.ts`, `db/seed/index.ts`, `db/seed/selfVerify.ts`; new `db/seed/guard.ts`, `guard.new.test.ts`.
**What exactly was changed?** The seed refuses unless `NODE_ENV=development` (or `SEED_ALLOW=1`) and the database host is local; it inserts into an empty database only; `SEED_RESET=1` drops and recreates the `public` schema and re-runs migrations.
**What tests prove the fix?** Guard tests 3/3; the agent ran migrate, seed, second-run refusal, `SEED_RESET=1` run, and a non-local-host refusal end to end on its own database.
**Is it fully fixed?** Yes. `LOCAL-README.md` still describes the old behaviour.

---

## Verified already fixed before the audit (no change needed)

| Item | Evidence |
|---|---|
| Reporting skipped late-committing lower outbox ids | Migration `0075` and per-event markers in `runConsumerPass.ts`; the audit added regression test `concurrentCommit.new.test.ts` and removed the dead UTC-bucketing `recordCaptureMetric` from `capture.ts` |
| Payment-link expiry trusted a client `submittedAt` | `routes/paymentLinks.ts:160-175` ignores it unless the owning merchant's API key is presented |
| Duplicate `settlement.paid` | Migration `0082` claims table; the real cause was duplicate outbox rows from a scan race, not NOTIFY replay |
| HMAC signs exactly the bytes sent, timestamp re-signed per attempt | `sign.ts`, `dispatcher.ts`; confirmed by test |
| Concurrent capture / void-vs-capture races | Row lock `FOR UPDATE` held through validation; void blocks then returns 409 |
| Settlement idempotency and duplicate-batch prevention | `UNIQUE(merchant_id, batch_date)`, row lock, status guard; double-pay blocked by a unique partial index on disbursements |
| OTP attempt budget and resend throttle | Attempt count carries across resends; exhaustion revokes the session; 30 s throttle |

---

# Cleanup pass (2026-10-30, later session)

No feature was removed. Wrong code was fixed in place; only unused imports and parameters were deleted. New tests are in `*.new.test.ts` / `*_new_test.go`.

| Fix | What was wrong | What changed | Test |
|---|---|---|---|
| `float32` money in Go | `payout_estimate.go` accumulated payouts in `float32` into a `REAL` column: exact only to 16,777,216 fils, so totals drifted for busy merchants | Column is now `DOUBLE PRECISION` (migration `0087`); Go passes `int64` and `EstimateMonthlyPayout` returns `money.Fils`; the seed sums integers instead of `Math.fround` | `payout_estimate_new_test.go` (16,777,217 + 1 + 123,456,789 stays exact) |
| Admin invite codes from `Math.random()` | `admin/inviteCode.ts` generated an onboarding credential with a predictable PRNG | Uses `crypto.randomInt` | `inviteCode.new.test.ts` |
| `parsePromotionalDiscountFils` | `parseFloat` and `* 100` (cents, float) | Uses `parseBhdToFils`; invalid or negative input is a `BadRequestError` | covered by typecheck; no callers yet |
| `fees/estimate.ts` | Float maths; discounted the fee instead of the amount; rounded half away from zero | Mirrors Go `ComputeSettlementFee` through `applyRateFils` | none (no callers yet) |
| `v1/fees/calculateFee.ts` | Rounded half up | Delegates to `applyRateFils` (half-even) | none (only the unregistered v1 route calls it) |
| `v1/routes/transactions.ts` | Unauthenticated, not merchant scoped, no amount bounds | Requires merchant auth and `owner`/`finance`, scopes by merchant, bounds the amount; still not registered by `app.ts` | none (unregistered) |
| `toUtcFromBahrain` | Comment said "inverted" and the function was undocumented | Documented; parses the date as UTC midnight explicitly | none |
| Payment links had no amount ceiling | A link above 99,999,999,990 fils could never settle | `paymentLinks/create.ts` rejects it with `amount_too_large`; the constant moved to `payments/limits.ts` | typecheck |
| `ops/.env.docker` tracked | A credential-like value lived in git while its comment said it was ignored | Untracked, added to `.gitignore`, `ops/.env.docker.example` added. **The old value is still in git history: rotate it** | n/a |
| Docker images carried the 15 MB seed dump | `db/seed/fixtures/production_seed.sql` is read by nothing in the images | Added to `.dockerignore` | n/a |
| Unused imports and parameters | `toFils`, `FastifyReply` (3 files), `reservationTimeoutSeconds` | Removed; stale chat comments in `paymentLinks/pay.ts` removed | typecheck with `--noUnusedLocals` |
| Report filter 500s | A malformed `from`/`to` or a non-string `status` in `GET /v1/reports/transactions?filter=` reached Postgres and returned 500 | New `reporting/parseReportFilter.ts` validates each field and returns 400 `invalid_filter`; `merchantId` is still never read from the client | `parseReportFilter.new.test.ts` |
| Admin bulk KYC approve | No confirmation before approving many merchants | `window.confirm` with the selected count | typecheck |
| Postgres exposed on all interfaces | `ops/docker-compose.yml` published 5432 on every interface with a dev password | Bound to `127.0.0.1:5432` | n/a |
| Stale or misleading comments | `payout_notify.go` cited a unique index that does not exist (the real guard is the `0082` claims table); `TransactionDetailPage.tsx` said capture/void have no server role check (they do); `RefundDrawer.tsx` header pointed at a route the code does not use | Comments corrected; chat-style notes removed | n/a |
| F-1 payout overpayment | `PayoutBatch` and `PayoutSplitBatch` paid the batch net even when refunds, credits or adjustments had reduced the merchant's `merchant_payable` position | Both hold the payout (batch stays `closed`, `Held` result, log line, `PayoutHeld` on the outcome) when the position is below the batch net; it pays once the position covers it | `payout_held_new_test.go` |
| S-4 KYC re-approval | An already approved or rejected merchant could be approved again, writing a second review | Single-merchant approval requires `submitted` or `under_review` under a row lock (409 `kyc_already_decided`) | `adminKycReview.new.test.ts` |
| S-5 CSV import | No row cap; an unknown merchant id surfaced as a 500 | Cap of 1000 rows (`too_many_rows`); unknown merchant is 400 `unknown_merchant` | typecheck + existing import tests |
| S-19 `NODE_ENV` unset | The API silently ran with development defaults | The process entrypoint refuses to boot without `NODE_ENV` | n/a |
| F-4 expired holds | A capture still succeeded after the hold expired | `capture.ts` returns 409 `authorization_expired` when the transaction has an expired or lapsed hold | `captureExpiredHold.new.test.ts` |
| F-9 idempotency keys | Never cleaned up | `scripts/purge_idempotency_keys.ts` deletes finished keys older than 30 days | `purge_idempotency_keys.new.test.ts` |
| F-10 refunded vs captured | No database guard | Migration `0088`: `CHECK (refunded_fils <= captured_fils) NOT VALID` | exercised by the full API suite |
| Business profile | Legal name and registration number could change after approval with no re-review | Changing either on an approved merchant sets `under_review` and `kyc_passed = false` | `businessProfileReview.new.test.ts` |
| API shutdown | No timeout and always exit code 0 | 20 s force-exit timer; exit code 1 on error | n/a |
| Compose | No restart policy, no wait for migrations, no API healthcheck | Added to `ops/docker-compose.yml` (validated with `docker compose config`) | n/a |
| KYC filename (locked test) | A PDF named `registration.docx` was accepted | For `commercial_registration` and `bank_letter` the extension must be `.pdf` as well as the bytes | `app.test.ts` (locked) now passes |
| API-key rotation grace (locked test) | Rotation revoked the old key instantly | Rotation sets `revoke_after = now() + 24h` on the old key (`ROTATION_GRACE_HOURS`); `verifyApiKey` enforces `revoke_after`, so it dies on time without a sweep job. `admin/apiKeys.new.test.ts` was rewritten to the grace behaviour because it encoded the opposite decision | `admin.test.ts` (locked) now passes |
| Webhook backoff (locked test) | `backoffDelayMs` always applied jitter, so its value was not deterministic | Jitter is opt-in; the dispatcher passes `Math.random`, so production behaviour is unchanged | `dispatcher.test.ts` (locked) now passes |
| Poisoned webhook row (locked test) | A row that failed before the transport call burned retry attempts and eventually exhausted | The row stays `pending` with its attempt count untouched, is pushed back by the backoff cap, and the error is kept in `response_body_excerpt` | `dispatcher.test.ts` (locked) now passes |
| Pool exhaustion answered 500 | When every pooled DB connection stayed busy past the connect timeout, the client got a generic 500 | `plugins/errorHandler.ts` maps it to 503 `service_busy` with `Retry-After: 1` | `errorHandlerPoolBusy.new.test.ts` |
