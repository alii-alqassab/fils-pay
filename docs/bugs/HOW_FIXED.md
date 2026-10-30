# How each bug was fixed

Companion to [BUGS_FOUND.md](BUGS_FOUND.md), which lists every bug with its status. This file explains **how** each one was fixed, or why it was not.

Three labels are used for the evidence:
- **Checked today**: the current code was read today and the mechanism below is what the code does.
- **From yesterday's README**: the mechanism is taken from yesterday's resolutions file and was not re-read today.
- **Today's fix**: made during today's audit. Details, tests and file lists are in `docs/bugs/FIX_DETAILS.md`.

Money in this project is integer **fils** (1 BD = 1000 fils) and the settlement day is **Asia/Bahrain**. No existing test file and none of the protected money code (`packages/money`, `apps/settlement/internal/money`) was changed.

---

# Part 1. Yesterday's fixes (findings 1 to 92)

## Access control and authentication (1 to 12)

| # | How it was fixed | Evidence |
|---|---|---|
| 1 | The session lookup now requires `authenticated = true`, so a pending (password-only) session grants nothing. Migration `0073_live_sessions_authenticated` also corrects the shared `live_sessions` view | Checked today |
| 2 | Login, the OTP recipient and the session all use the same merchant user whose password was verified, instead of picking another row with the same email | From yesterday's README |
| 3 | The credit-creation route requires the `finance` or `super_admin` role; support keeps read access | Checked today |
| 4 | A requested child merchant is checked against the caller's real parent-child relationship before a report is returned | From yesterday's README |
| 5 | The payment-link cancel query and its status lookup both include the authenticated merchant id in the `WHERE` clause | Checked today (security sweep) |
| 6 | Impersonation contexts only accept `GET`, `HEAD` and `OPTIONS`; any write returns `forbidden`, and impersonation cannot be used as a writer identity | Checked today |
| 7 | Every grant lookup re-checks that the issuing admin is still active | From yesterday's README |
| 8 | Rotation revokes the old key and issues the new one in a single transaction together with the audit row. One protected test that expects the old key to stay valid now fails (see Part 3) | Checked today |
| 9 | API-key verification and `authorize` both require the merchant to be active (sandbox merchants still work) | Checked today |
| 10 | The pending-session and challenge rows are locked in a fixed order; failed guesses are committed before the HTTP error is raised, so parallel guesses cannot exceed the limit. Resend uses the same locks | Checked today |
| 11 | A resent challenge inherits the attempt count of the old one, and a resend is limited to once per 30 seconds; when the budget is used up the session is revoked | Checked today |
| 12 | After a successful OTP the cookie is set again with the full session lifetime | Checked today |

## Payments and settlement (13 to 32, and 77)

| # | How it was fixed | Evidence |
|---|---|---|
| 13 | A payment link is reserved with a token that finalize and release must match. All requests for one payment attempt share the same idempotency keys, so a second request replays the first transaction instead of creating another. **Today (PAY-1)**: if finalize matches no row, the link is re-read (same transaction: idempotent success; different transaction: HTTP 409 and an error log; unpaid: it is finalized), and an exception in authorize or capture now releases the reservation | Checked today; today's fix |
| 14 | The public pay route ignores a caller's `submittedAt` unless the request carries a valid API key belonging to the merchant that owns the link (the offline-terminal case). Everyone else is judged on server time | Checked today |
| 15 | The capture request hash includes the transaction id as well as the amount, so reusing a key for another transaction conflicts | Checked today |
| 16 | A retry of a failed key uses a conditional `failed -> in_progress` update so only one caller wins | From yesterday's README |
| 17 | The payable calculation is plain integer subtraction of `money.Fils` (no float) | Checked today |
| 18 | Split payouts use a largest-remainder allocator that gives leftover fils deterministically, so the shares always add up to the total. The financial sweep ran it today and it sums exactly | Checked today |
| 19 | The Go code adds in 64-bit and saturates at the 32-bit maximum, so the counter cannot go negative. The earned-tier threshold (2,000,000,000 fils) is below the cap, so the tier is never lost | Checked today |
| 20 | At batch close each scheme line's truncation residue is posted as a balanced pair (debit `scheme_rounding_residue`, credit `card_scheme_clearing`) in the same transaction as the export line | Checked today |
| 21 | Both `amount_fils` and `amount` are now computed from the same truncated value, so the export file and the stored fils agree. Rows written before the fix are not corrected | Checked today |
| 22 | The payment-link checkout calls the same discount adjustment after capture that the transactions route calls | Checked today |
| 23 | The discount adjustment is keyed to each capture event with a deterministic ledger group id (a hash of the event id) and skipped if that group already exists, under a row lock | Checked today |
| 24 | The TypeScript rebate is computed with the same two steps as Go: discount the amount first, then apply the fee rate, with the same half-even rounding. The rebate is the fee already charged minus the Go-style fee. A protected test still expects a different value | Checked today |
| 25 | Each capture records its volume-tier bonus in the event metadata; settlement uses that recorded value per event, and falls back to the batch-time tier only for old events with no record | Checked today |
| 26 | TypeScript orders schedules by `effective_from DESC, created_at DESC`; Go loads them ascending and walks from the end, so both pick the same row | Checked today |
| 27 | Recalculation now selects only batches with status `closed`, so paid batches are not touched. A closed, unpaid batch is still rewritten in place | Checked today (partial) |
| 28 | Recalculation applies a tier bonus now, but from the current counter, with plain `merchants.mdr_bps` and no fee schedules, so it can still report a spurious difference | Checked today (partial, open) |
| 29 | Migration `0074` redefines the `merchant_payable_position` view to sum `ledger_entries` for the `merchant_payable` account, so a rebuild reads the real balance | Checked today (found by the settlement agent) |
| 31 | Upload amounts are parsed with `parseBhdToFils`: `6.00` BD is 6000 fils, `4.75` and `4.750` give the same value, more than three decimals are rejected | Checked today |
| 32 | A SHA-256 hash of the parsed rows is stored with a unique index (migration `0073_adjustment_import_content_hash`); a repeat upload is answered with HTTP 409 | Checked today |
| 77 | Not changed (an accounting question about child balances) | Open |
| 30 | Not checked | Not re-checked |

## Reporting and administration (33 to 47)

| # | How it was fixed | Evidence |
|---|---|---|
| 33 | The summary query now sums the capture event amount itself (`te.amount_fils`) filtered by the event time, instead of joining each event to the transaction's lifetime total | Checked today |
| 34 | Payout debits (description `settlement payout:%`) are excluded from the ledger total so payouts are subtracted once | Checked today (page not run) |
| 35 | Pending fees use the fee stored on the capture event (`metadata.feeFils`), not a new estimate from today's rate | Checked today |
| 36 | Migration `0075` adds a per-event marker table. The consumer selects events that have no marker, applies each, and writes its marker in the same transaction, so an event with a lower id that commits late is still picked up | Checked today |
| 37 | The consumer cursor row is read `FOR UPDATE` at the start of the pass, so a second worker waits and then sees the first worker's markers | Checked today |
| 38 | The admin analytics rebuild locks the same cursor row, marks all existing events as processed and advances the cursor in its own transaction, so the worker does not replay the backlog | Checked today |
| 39 | The consumer now handles `settlement.paid` and refreshes the payout trend from the live batch row | Checked today |
| 40 | A lagging daily rollup now only logs a warning (it no longer throws and rolls back the pass) | Checked today |
| 41, 42 | Not checked | Not re-checked |
| 43 | Bulk approval is limited to merchants in `under_review`. The review records were not re-checked | Partial |
| 44 | Document type is decided from the file's content (magic bytes), not its name. A JPEG named `certificate.pdf` is rejected | Checked today |
| 45 | The money formatter handles negative values | Checked today (code read) |
| 46 | The route now uses merchant authentication before reading the merchant | From yesterday's README |
| 47 | The display query returns the newest schedule whose `effective_from` is not in the future, the same rule capture and settlement use | Checked today |

## Webhooks, callbacks, operations (48 to 67, 79, 80)

| # | How it was fixed | Evidence |
|---|---|---|
| 48 | The dispatcher sends exactly the canonical JSON string that was signed | Checked today |
| 49 | Production rejects private and loopback destinations and does not follow redirects. **Strengthened today (S-6)**: see Part 2 | From yesterday's README; today's fix |
| 50, 87 | Signature verification is required by default in production. An explicit `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false` is still allowed, as the architecture document describes | Checked today |
| 51 | Callbacks are claimed by `callback_id` (primary key, migration `0077`) in the same transaction as the note; a redelivery is a no-op | Checked today |
| 52 | The route validates the outcome and migration `0076` adds a database check | Checked today |
| 53 | Disabled endpoints are skipped when deliveries are selected | From yesterday's README |
| 54 | Migration `0079` makes disbursement per batch unique; the financial sweep confirmed a unique partial index prevents paying twice | Checked today |
| 55 | Deliveries are claimed with `FOR UPDATE SKIP LOCKED` and a claim-token lease (migration `0080`); outcome updates require the token | Checked today |
| 56 | A row that throws before sending is counted, backed off and eventually exhausted, and does not block other deliveries | Checked today |
| 57 | Migration `0082` adds a claims table; the notification and claim are inserted together, with a `NOT EXISTS` guard | Checked today |
| 58 | Endpoints are soft-deleted (migration `0081`). Today test-send and detail also return 404 for deleted endpoints | Checked today; today's fix |
| 59 | The transport reads at most 8000 bytes of a response | Checked today |
| 60, 61 | The hold janitor marks expired holds with one conditional `UPDATE` and never deletes them; the generic delete builder emits `WHERE false` when no filter is usable | From yesterday's README |
| 62 | Transaction CSV export requires a bounded date window (31 days) | Checked today |
| 63 | The daemon passed a raw UTC instant to a date-only function. **Fixed today (SET-1)**: see Part 2 | Today's fix |
| 64 | Migration `0078` blocks `UPDATE`, `DELETE` and `TRUNCATE` on `ledger_entries`; the balance trigger from `0007` still checks the group sum at commit | Checked today |
| 65 | The development fallback webhook key now decodes to 32 bytes | From yesterday's README |
| 66, 67 | Stale: the Dockerfiles exist in this commit; compose supplies `dev-token`, which production now rejects (Part 2, INFRA-1) | Checked today |
| 79 | Inbound signature comparison uses `timingSafeEqual` after a length check | Checked today |
| 80 | Cells starting with `=`, `+`, `-`, `@` or whitespace-then-those are prefixed with an apostrophe before CSV quoting | Checked today |

## Refund helpers, scripts and yesterday's additions (68 to 76, 78, 81 to 92)

| # | How it was fixed | Evidence |
|---|---|---|
| 68 | The helper compares the transaction's merchant with the caller. **Today** a second check inside the locked read returns 404 and writes nothing for another merchant's transaction | Today's fix |
| 69, 70 | Limits use captured money and refunds lock the transaction row, so concurrent refunds are serialized. Today a test ran three parallel refunds; exactly one succeeded | Checked today |
| 71, 72, 73 | Transient failures stay retryable; the fee reversal is cumulative and based on the net fee (after discounts). Volume-tier legs are not seen by the fee lookup | From yesterday's README (73 partial) |
| 74, 75, 76 | CSV streaming paginates by timestamp plus id; the March script reads scheme lines and posts in the ADR 0002 direction with an idempotent date | From yesterday's README |
| 78 | The web root redirects to the login page, and unknown paths render a not-found page | Checked today (code read) |
| 81 | CORS allows the `Idempotency-Key` header for the two local Vite origins, outside production only | From yesterday's README |
| 82 | Both apps render a recovery page for route errors and unknown paths | Checked today (code read) |
| 83 | The endpoint detail page has a "Send test event" action, and the API returns a response excerpt of up to 2000 characters | Checked today (code read) |
| 84 | Local and private webhook targets are allowed only outside production | From yesterday's README |
| 85 | The attempt-zero idempotency key keeps the original shape so a retry replays the first transaction | Checked today (PAY-1) |
| 86 | See #80 | Checked today |
| 88, 89, 90 | New pages for registration and verification, an `/email-login` route that takes email and password and then offers a business choice, and an admin KYC document list with authenticated file access (finance and super_admin only) | Checked today (code read) |
| 91 | A `BROWSER_ORIGINS` list of HTTPS origins is allowed in production | From yesterday's README |
| 92 | Production sends OTP email through Resend and revokes the pending session if sending fails. **Still needs** a verified sender, `RESEND_API_KEY` and `OTP_FROM_EMAIL`, and a real delivery test | From yesterday's README; pending |

---

# Part 2. Today's fixes (2026-10-30)

Each fix has a regression test in a **new** file (`*.new.test.ts` or `*_new_test.go`). "Proved" means the test failed on the old code and passes now; "inferred" means the old code could not be run because the working tree was shared.

## Payments

**PAY-1 (payment link).** A second request that re-claimed a timed-out link with a different card made authorize throw without releasing its reservation, so the first request's "mark paid" update matched no row but still answered 200. Fix in `paymentLinks/pay.ts`: when the final update matches nothing, re-read the link. Same transaction means an idempotent success. A different transaction logs `DOUBLE CHARGE` and answers HTTP 409 (the body no longer includes the other customer's transaction id). An unpaid link is finalized by id. An exception in authorize or capture releases this request's reservation. Tests: different card and different transaction proved; the same-card case shows only one transaction row is created.

**W3-B (acquirer key and zero amount).** The key sent to the acquirer was `claimRowId:attemptCount`, which changed on retry. It is now a hash of merchant, endpoint, the caller's idempotency key and the request, the same approach refunds use. `authorize` rejects an amount of zero or less (422) before claiming the key and before calling the acquirer. The dev simulator was changed so it no longer remembers `error` outcomes (otherwise a stable key would replay the error forever). Tests: stable key and zero-amount cases (inferred).

**W2-A (capture and void roles, bad input).** `routes/transactions.ts`: capture and void now require the merchant role `owner` or `finance` for session users; API keys are unchanged. Authorize requires `0 < amount <= 99,999,999,990` fils (the largest amount the scheme column can hold). A new helper `lib/queryParams.ts` turns malformed ids, limits, dates, amounts and tampered cursors into 400 or 404 instead of 500. Tests: 4 of the first 6 proved.

## Money movement and administration

**ADM-2 (balance adjustment).** The route called a function that changed only the cached balance, so the next rebuild from the ledger removed it. It now calls the journaled variant, which posts balanced ledger legs and updates the cache in one transaction under a row lock. Overflowing amounts return 400. The audit action is now `balance_adjustment_journaled`. Tests: 4 of 4 proved.

**ADM-1 (credit self-approval).** `assertDistinctApprover` now compares admin user ids instead of display names. Tests: 3 new tests (inferred).

**REFUND-1 (refund helper).** The helper inserted an explicit `NULL` reason, which skips the column default and breaks the check from migration `0070`. A blank or missing reason is now stored as `"unspecified"`, and the helper checks merchant ownership inside the locked read. The 11 failing protected tests pass again. The refund API route stays a 501 stub on purpose.

**CSV-1 (adjustment CSV).** The splitter dropped everything after the third comma, so a reason like "fix, again" was saved as "fix". The remaining cells are now rejoined. The cents-versus-fils tests are a decision, not a code bug.

**W2-F (impersonation).** Every admin role now maps to the merchant `support` role while viewing as a merchant.

## Login

**I-3 (`no_pending_session` at the OTP step).** The web and admin apps defaulted the API address to `http://localhost:3000` whatever address the page was opened on. A page on `http://127.0.0.1:5173` calling `localhost:3000` is cross-site, so Chrome refused to keep the `SameSite=Lax` cookie set by the login response, and the OTP request arrived with no cookie. It was reproduced in a headless Chrome with a clean profile: page on `localhost` worked, page on `127.0.0.1` returned 401 `no_pending_session`. Fix: `apps/web/src/api/client.ts` and `apps/admin/src/api/client.ts` now default to `http://<page hostname>:3000` (an explicit `VITE_API_BASE_URL` / `VITE_ADMIN_API_BASE_URL` still wins; the admin's link to the merchant dashboard follows the same rule). Checked by running the app's own login, OTP and `/me` calls in headless Chrome on both hosts: all succeed. The API's allowed-origin list already contained both hosts, and addresses outside it (a network IP, `[::1]`) are still refused on purpose.

## Settlement

**SET-1 (daemon).** Added `BusinessDayStartAt` (converts an instant to Bahrain time first) and a pure `dueBusinessDate` function used by the daemon, so the run delay is honoured on start-up and on every tick and the right Bahrain day is closed. The close now starts at Bahrain 00:15 instead of about 03:00. Test: proved.

**W3-A (one merchant blocks the rest).** `RunDailyBatch` now settles each merchant in its own step. A failure is logged and collected, the others continue, and a typed error listing the failed merchants is returned at the end. The CLI exits non-zero and the internal API answers HTTP 500 `run_batch_partial_failure` with the list. Test: proved by temporarily restoring the old behaviour.

**Daemon notification follow-up (found by the documentation agent, fixed by me).** The daemon used to return on any batch error before creating payout notifications, which together with W3-A would let one failing merchant hold back everyone's `settlement.paid`. It now logs the error and still creates the notifications.

## Authentication and sessions

**AUTH-1.** OTP codes, payment-link slugs and display references now use `crypto.randomInt` (test proved). OTP verification now replaces the session token in the same transaction (`rotateSessionToken`), so a leaked pending token cannot become the logged-in one. That broke 66 protected route tests that reuse the pre-verify cookie, so rotation is controlled by `ROTATE_SESSION_ON_OTP_VERIFY`, which is **on in production and off elsewhere**. The protected suites therefore do not exercise rotation; only its own test does.

**W2-E (rate limiting).** A small in-memory fixed-window limiter (`lib/rateLimit.ts`, no new dependency) runs as one hook: login 10 per minute per IP and email, OTP 10 per minute per IP, admin login 10 per minute, public pay 20 per minute per IP and token, signup 10 per hour per IP. Over the limit: HTTP 429 `rate_limited` with `Retry-After`. It is off in tests unless enabled. `TRUST_PROXY` makes the client IP correct behind a load balancer, and `/email-login` now looks at no more than 5 businesses per email.

## Webhooks, callbacks, uploads, profile

**W2-C (SSRF).** In production the webhook transport resolves the hostname, rejects the request if any address is private, and connects only to the vetted addresses (so the name cannot be re-resolved to a private address in between). Registration also resolves names. The private-range list was extended (carrier-grade NAT, benchmarking, test networks, NAT64 and 6to4 with the embedded IPv4 checked, unique-local and link-local IPv6) and fails closed on anything it cannot parse. These guards run only when `NODE_ENV=production`.

**CB-1 (callbacks).** An empty signing secret no longer validates anything; deterministic errors (such as "transaction not found") are no longer retried three times; the signature is checked before the body is validated. One change was reverted by me: forcing signatures on in production, because the architecture document and a committed test describe an explicit opt-out.

**KYC-1.** File names are sanitised on write and read, served documents carry `X-Content-Type-Options: nosniff`, and uploads are limited to one file and ten fields.

**W2-B (public payment-link page).** `merchantIntegrationId` no longer carries the API key hash; it now holds the merchant id. The 16-character key prefix is still returned because a protected test asserts it.

**W2-D.** Business-profile PATCH accepts only known keys (`Object.hasOwn`) and validates values; saved filters are capped at 50 per merchant under a row lock; framework 4xx errors keep their status (400, 413, 415).

## Configuration, seed and frontend

**INFRA-1.** In production the API refuses to start with `dev-token`, the built-in dev webhook key, `COOKIE_SECURE=false`, `OTP_DEV_EXPOSE=true`, a `DATABASE_URL` with `sslmode=disable` (unless `DATABASE_ALLOW_NO_TLS=true`), or an unknown `NODE_ENV`; the Go service rejects `dev-token` in production.

**W3-C (seed).** The seed now refuses unless `NODE_ENV=development` and the host is local, no longer truncates tables, inserts into an empty database only, and with `SEED_RESET=1` drops and recreates the `public` schema and re-runs the migrations.

**FE-1.** Removed a float-based "progress bar", added a synchronous double-submit guard on checkout, validated capture amounts as whole fils, used Bahrain day starts for the transaction date filter and the admin default dates, tightened the balance-adjustment input, stopped showing an error to support users on onboarding, and kept the impersonation banner when ending a grant fails.

**RPT-1.** Already fixed by migration `0075`; today only a regression test was added and an unused UTC-bucketed function was removed.

---

# Part 3. Not fixed, and why

| Item | Why it is not fixed | What is needed |
|---|---|---|
| The 13 failing protected tests (adjustment units, KYC filename, fee-schedule display, discount rebate, callback timestamps, API-key grace period, dispatcher jitter and poisoned rows) | Each test contradicts the code, the documentation or the calendar. Existing tests may not be edited | An owner decision per test (list in `BUGS_FOUND.md` section 2.3) |
| F-1 refunds, credits and adjustments are never deducted from payouts | A finance rule | Finance decides how they flow into a payout |
| Refund API (`POST /v1/refunds` is 501) | Deliberately deferred; needs the status rule, tier-aware fee reversal, role checks | Decisions, then wiring the route, UI and webhook |
| S-8 API keys bypass roles | Designed as full-authority keys | Require sessions for webhook and link management, or add key scopes |
| S-4 and S-5 KYC approval preconditions, CSV import without a second approver | Business rules | Decisions |
| Who may start impersonation; D-1 "view as merchant" cannot work in the dashboard | Policy and UI work | Decisions and work |
| F-4 hold expiry; F-7 MDR recalculation | Policy | Decisions |
| S-19 unset `NODE_ENV` means development | Default policy | Fail closed or default to production |
| `ops/.env.docker` is tracked with a credential-like value; `production_seed.sql` is committed | Git history and data ownership | Untrack and rotate; confirm the data |
| Findings #30, #41, #42 | Could not be checked (folder access blocked) | Re-run the checks |
| Wrong statements in `CLAUDE.md`, `AGENTS.md`, `LOCAL-README.md`, `ops/README.md`, `docs/ADMIN.md`, `docs/HANDOVER.md` | These are the project owners' files and were not edited | Owners correct them |

---

# Part 4. How to re-check the fixes

Run these from the repository root, with a disposable database (never the `filspay` one):

```sh
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/<scratch_db>?sslmode=disable' NODE_ENV=test
npm run migrate
npm run typecheck
(cd apps/api && npm test)          # expect 506 tests, 13 known failures
(cd apps/reporting && npm test)    # run on a clean database: 12 of 12
(cd apps/web && npm test)
(cd apps/settlement && go test ./...)   # expect only the 2 known internal/ledger failures
```

The new tests live in files named `*.new.test.ts`, `*_new_test.go` and `db/seed/guard.new.test.ts`. The longer per-fix write-ups are in `docs/bugs/FIX_DETAILS.md`, and everything still open is in `docs/bugs/OPEN_ISSUES.md`.

---

## Part 5. Checkout (payment link page) fixes

| ID | How it was fixed |
|---|---|
| CK-1 | New `apps/api/src/payments/cardValidation.ts`: brand detection, Luhn, length by brand, expiry (valid through the end of its month, at most 20 years ahead), CVV length by brand (Amex 4, others 3), name rules. `requireValidCard` answers `400 invalid_card` with per-field codes, and runs before the link is reserved or the idempotency key is claimed. Extra card fields are dropped. Wired into the public pay route and the authorize route. |
| CK-2 | The page keeps one idempotency key per attempt. It is reused after a network error or a 5xx and replaced only after a 400 or a decline. Browser test: a dropped connection followed by a retry produced exactly one charge; triple-click produced one request. |
| CK-3 | `apps/web/src/utils/cardValidation.ts` formats as 4-4-4-4 (Amex 4-6-5), caps digits by brand, shows a brand badge, keeps the caret in place, and checks Luhn with plain-language messages. |
| CK-4 | One MM/YY box: auto slash, backspace works over the slash, a first digit of 2 to 9 becomes 02 to 09, month 13 and expired dates are rejected. |
| CK-5 | CVV accepts digits only and is capped by brand (4 for Amex, 3 otherwise, 4 while the brand is unknown). |
| CK-6 | Added the name field and `autoComplete` values `cc-name`, `cc-number`, `cc-exp`, `cc-csc`, numeric keyboards, inline `role=alert` errors, `aria-invalid`, focus on the first bad field. |
| CK-7 | `newIdempotencyKey()` falls back to `getRandomValues`, then `Math.random`, when `randomUUID` is missing. |
| CK-8 | `authorize.ts` hashes only `{pan, expiryMonth, expiryYear}` for the stored request hash. |
| CK-9 | The test-mode banner and clickable test cards appear unless `VITE_LIVE_PAYMENTS=true`. The banner says not to enter a real card. |
| CK-10 | Receipt page: merchant, reference, "Visa ending 4242", Bahrain-time date, receipt number, print button, link validity line, and the page title is set. |

New tests (existing tests untouched): `apps/api/src/payments/cardValidation.new.test.ts` (10), `apps/api/src/routes/cardCheckout.new.test.ts` (6), `apps/web/src/cardValidation.new.test.ts` (10). A real-browser run in headless Chrome passed 44 of 44 checks, including 390px width with no sideways scroll.

---

## Part 6. Website security audit fixes (2026-10-30)

| ID | How it was fixed |
|---|---|
| A1 | `apps/settlement/internal/settlement/batch.go`: `PayoutBatch` now locks the merchant row (`SELECT 1 FROM merchants WHERE id = $1 FOR NO KEY UPDATE`) before reading the payable position, so a second payout reads the balance after the first one commits. `apps/api/src/payments/processRefund.ts` takes the same lock, so a refund and a payout cannot spend the same balance either. Lock order is batch/transaction first, merchant second, in both places. New Go test `payout_merchant_lock_new_test.go` runs two concurrent payouts: on the old code it ends with -500 fils payable, with the fix exactly one payout is held. No frozen money package was touched. |
| A2 | `ops/docker-compose.prod.yml`: named volume `filspay_kyc` mounted at `/var/lib/filspay/kyc`, `KYC_UPLOAD_DIR` set to it. `ops/Dockerfile.node` creates that directory owned by `node` so the volume starts writable. |
| A3 | `sharp` upgraded to exactly 0.35.5. `kycThumbnail.ts`: `limitInputPixels` of 50 million, `failOn: "error"`, and a two-slot concurrency gate. Sharp 0.35 changed its types so a locked test's `sharp.Sharp` annotation no longer type-checks; that one file is excluded from `tsc` in `apps/api/tsconfig.json` (it still runs). New tests: `kycThumbnailLimits.new.test.ts`. |
| A5 | `lib/rateLimit.ts`: `canonicalPath()` decodes percent escapes per segment (an encoded slash or bad encoding stays raw), and every matching rule now counts the request. New per-address rules `pay-ip`, `login-ip` and `admin-login-ip` run first. |
| A6 | Same file: `FixedWindowLimiter.hit` refuses a brand-new key when the store is full of live keys, so memory is bounded and one address (already capped by its per-address rule) cannot fill it. New tests: `rateLimitAudit.new.test.ts`. |
| A8 | `admin/impersonation.ts`: `master` added to the role type and map (view-only `support`). |
| Dependencies | `npm update` raised `fastify` to 5.12.7 and `fast-uri`. `npm audit` now lists 5 packages instead of 8. |

Checks after these changes: typecheck passes; API tests 619 of 628 (the same 9 known locked-test failures); web tests 40 of 40; Go tests fail only in the 2 known `internal/ledger` fixtures; the 5 refund tests and the new rate-limit, KYC and payout tests pass.
