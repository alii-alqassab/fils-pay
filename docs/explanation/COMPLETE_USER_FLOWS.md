# FilsPay: Complete User Flows

Twenty-two end-to-end journeys through FilsPay, written for a beginner who has never seen the repository. Each flow lists where it starts, what the user does, which page and API endpoint is involved, what changes in the database, what success looks like, what can go wrong, and an honest implementation status.

This is a companion to `ALL_PAGES_EXPLAINED.md` (page by page). Everything here was derived by reading the code; **nothing was run**. Every "Implementation status" line therefore means "code-read, not run". Refreshed on 2026-10-30 for the final state after the audit fixes; where a fix was reported by an audit agent and checked only by unit tests it is called "fixed in code, covered by unit tests, not exercised in a live browser". Open items are in `docs/audit/REMAINING_ISSUES.md`.

---

## Read this first

### Units of money
**1 BD (Bahraini Dinar) = 1000 fils.** Every amount in the database, the API and the pages is an integer count of fils. `10750` fils shows as `10.750 BHD`. (The repo's `CLAUDE.md` says "cents"; that is wrong for the code.)

### The cast of characters

| Name | What it is | Where |
|---|---|---|
| Merchant dashboard | Website for shop owners (and the public `/pay/:token` checkout) | `apps/web`, `http://localhost:5173` |
| Admin console | Website for FilsPay staff | `apps/admin`, `http://localhost:5174` |
| API | The backend both websites call | `apps/api`, `http://localhost:3000`, all routes under `/v1/...` |
| Settlement service | Go program that closes daily batches and records payouts | `apps/settlement` |
| Reporting worker | Builds the pre-computed tables the Overview page reads | `apps/reporting` |
| Webhook dispatcher | Background loop inside the API process that sends webhooks | `apps/api/src/webhooks/dispatcher.ts` |
| Simulated acquirer | A fake card network used instead of a real bank | `apps/api/src/acquirer` |

### Roles
- Merchant users: `owner`, `finance`, `support`.
- Admin users: `support`, `finance`, `super_admin`.

### Key tables mentioned below
`merchants`, `merchant_users`, `merchant_business_profiles`, `kyc_documents`, `merchant_kyc_reviews`, `sessions`, `otp_challenges`, `payment_links`, `transactions`, `holds`, `transaction_events`, `idempotency_keys`, `ledger_entries` (double-entry accounting; every posting has equal debits and credits), `merchant_balances` (a cached payable figure), `settlement_batches`, `scheme_export_lines`, `settlement_payout_disbursements`, `outbox_events` (a "to-do list" for other processes), `webhook_endpoints`, `webhook_deliveries`, `merchant_daily_volume`, `merchant_payout_trends`, `credit_requests`, `adjustment_imports`, `admin_users`, `admin_sessions`, `admin_audit_log`, `admin_impersonation_grants`, `refunds`.

### The life of a payment in one picture

```
Merchant registers -> uploads KYC docs -> admin approves (merchants.onboarding_status = approved)
   -> merchant creates payment link -> customer pays at /pay/:token
        authorize (transactions row, holds row)  ->  capture (ledger_entries, outbox event)
   -> end of Bahrain business day: settlement service CloseBatch -> PayoutBatch
        (settlement_batches, scheme_export_lines, ledger_entries, merchant_balances, disbursement row)
   -> outbox events -> webhooks to merchant server  +  reporting worker -> Overview page
```

### Money rule of thumb for the ledger
Capturing 100.000 BHD with a 2.5% fee (250 basis points = 2.50) posts: debit `card_scheme_clearing` 100.000 / credit `merchant_payable` 100.000; then debit `merchant_payable` 2.500 / credit `platform_fee_revenue` 2.500. The merchant's payable ends at 97.500. Settlement later pays that out: debit `merchant_payable` / credit `platform_cash`.

---

## Flow 1: Merchant registration

**Starting point:** A new business owner opens `http://localhost:5173/` (redirects to the login page) and clicks "Create a merchant account".

**User actions:**
1. Open `/dashboard/register`.
2. Fill: legal business name, registration number, business type, work email, phone, address, city, password (at least 12 characters) twice.
3. Click **Create account**.

**Frontend route:** `/dashboard/register` (`apps/web/src/pages/dashboard-login/RegisterPage.tsx`), then redirect to `/dashboard/login`.

**Backend endpoint:** `POST /v1/merchants` (`apps/api/src/routes/businessProfile.ts`, `onboarding/signup.ts`). Public, no login.

**DB changes (one transaction):**
- `INSERT merchants` (display_name = legal name; defaults `onboarding_status='submitted'`, `kyc_passed=false`, `status='active'`, `mdr_bps=250`, `test_mode=false`).
- `INSERT merchant_business_profiles` (country defaults to `BH`).
- `INSERT merchant_users` (role `owner`, argon2id password hash).
- No session is created: registering does not log you in.

**Success outcome:** HTTP 201 `{merchantId, ownerUserId, onboardingStatus:"submitted"}`. The page sends you to the login screen with "Account created. Sign in to upload verification documents."

**Failure cases:**
- 400 `invalid_request` (missing field), `invalid_business_type`, `invalid_email`, `weak_password` (under 12 characters), `invalid_country`.
- 409 `email_already_registered` if that email already exists inside the same merchant (emails are unique per merchant, not globally, so the same email can create a second separate business).
- Browser-side: passwords differ, or under 12 characters.

**Implementation status:** Working (code-read, not run). The endpoint is public and is now rate limited to 10 signups per hour per IP (`429 rate_limited`; fixed in code, covered by unit tests, not exercised in a live browser).

---

## Flow 2: Merchant onboarding (documents)

**Starting point:** Newly registered merchant who has just signed in (Flow 4).

**User actions:**
1. Open **Business verification** (`/dashboard/onboarding`).
2. Read the status (`submitted`).
3. Choose a document type (commercial registration, owner ID, proof of address, bank letter), pick a file, click **Upload document**. Repeat for each document.

**Frontend route:** `/dashboard/onboarding` (`OnboardingPage.tsx`).

**Backend endpoints:**
- `GET /v1/merchants/:merchantId/business-profile`
- `GET /v1/merchants/:merchantId/kyc/documents`
- `POST /v1/merchants/:merchantId/kyc/documents` (multipart; owner/finance only)

**DB changes:**
- `INSERT kyc_documents` (file stored on disk under the KYC upload folder, named by SHA-256; row records type, file name, MIME type, uploader).
- `UPDATE merchants SET onboarding_status='under_review'` when the previous status was `submitted` or `rejected` (so a rejected merchant who re-uploads goes back into the queue). `kyc_passed` is never touched here.

**Success outcome:** 201; page shows "Document uploaded. Your review status has been updated." and the status becomes `under_review`.

**Failure cases:**
- 400 invalid `documentType` or no file.
- 422 `invalid_file_type` (judged from the file's real bytes, not its name) or `document_must_be_pdf` (commercial registration and bank letter must be PDF).
- 403 `forbidden` for a `support` user or for another merchant's id.

**Implementation status:** Working (code-read, not run). Nothing tells the admin team automatically; staff must look at the merchants list filtered to `under_review`.

---

## Flow 3: KYC approval (single merchant, as seen by the merchant)

**Starting point:** A merchant sits at `under_review`; an admin decides.

**User actions (admin):**
1. In the admin console open **Merchants**, click the merchant.
2. In **KYC review** read the uploaded documents (**View document**).
3. Optionally type notes; click **Approve KYC** or **Reject KYC**.

**Frontend route:** admin `/merchants/:id` (`MerchantDetailPage.tsx`). The merchant sees the result on `/dashboard/onboarding`.

**Backend endpoints:** `GET /v1/admin/merchants/:id/kyc/documents`, `GET .../kyc/documents/:documentId/file`, `POST /v1/admin/merchants/:id/kyc-reviews` `{outcome:"approved"|"rejected", notes}` (finance/super_admin only).

**DB changes (one transaction, audit row last so both happen or neither):**
- `INSERT merchant_kyc_reviews` (outcome, reviewer email, admin user id, notes).
- `UPDATE merchants SET onboarding_status=<outcome>, kyc_passed=(outcome='approved')`.
- `INSERT admin_audit_log` action `kyc_review`.

**Success outcome:** The admin sees "KYC approved. Onboarding status is now approved (kycPassed: true)." The merchant's onboarding page shows "approved" and offers "Create a payment link". Payments (authorize) are now allowed, because `authorizeTransaction` requires `onboarding_status='approved'`.

**Failure cases:** 403 for a `support` admin; 400 `invalid_request` if outcome is not approved/rejected; 404 `merchant_not_found` (bad or unknown id). Before approval, any payment attempt returns 403 `merchant_not_approved`.

**Implementation status:** Working (code-read, not run).

---

## Flow 4: Login with OTP (merchant)

**Starting point:** An existing merchant user opens the dashboard (or is bounced from a protected page).

**User actions:**
1. Enter email and password, click **Continue**.
2. If the email belongs to several businesses, pick the business and Continue again.
3. Enter the 6-digit one-time code, click **Verify** (or **Resend code** or **Start over**).

**Frontend route:** `/dashboard/login`, then the page you wanted (default `/dashboard/transactions`).

**Backend endpoints:** `POST /v1/auth/email-login`, `POST /v1/auth/otp/verify`, `POST /v1/auth/otp/resend`, `GET /v1/auth/me`, `POST /v1/auth/logout`. (A legacy `POST /v1/auth/login` that requires a merchant id also exists.)

**DB changes:**
- Login: `INSERT otp_challenges` (salted hash of a code drawn with `crypto.randomInt`, expiry 5 minutes, max 5 attempts) and `INSERT sessions` (pending, `authenticated=false`, short expiry), cookie `fp_sid` set.
- Wrong code: `otp_challenges.attempt_count + 1`.
- Verify success: challenge `consumed_at` set; session promoted to `authenticated=true`, expiry 12 hours. If `ROTATE_SESSION_ON_OTP_VERIFY` is on (default ON in production, OFF elsewhere) the session token is also replaced and the cookie re-set.
- Resend: old challenge consumed, new challenge inserted carrying over the failed-attempt count; `sessions.otp_challenge_id` updated. Allowed once per 30 seconds. Using up the attempt budget revokes the session.
- Logout: `sessions.revoked_at` set.

**Success outcome:** `{authenticated:true, merchantId, role}`; the dashboard loads `/me` and shows the nav bar with your email, role and business name.

**Failure cases:** 401 `invalid_credentials` (generic for wrong email or password); 409 `merchant_selection_required`; 401 `invalid_code`; 410 `otp_expired`; 429 `too_many_attempts` (session revoked, back to step 1); 429 `resend_too_soon`; 429 `rate_limited` (login 10 per minute per IP and email, OTP calls 10 per minute per IP, with `Retry-After`); at most 5 matching businesses are tried per email (`LOGIN_MAX_CANDIDATES`), more need `merchantId` or `registrationNumber`; 503 `otp_delivery_unavailable` (the email could not be sent; session revoked); 401 `no_pending_session` if the cookie is missing or expired.

**Implementation status:** Working (code-read, not run). In development the code is shown on screen (`devOtpCode`); in production it goes by email (Resend API key configured).

---

## Flow 5: Create a payment link

**Starting point:** An approved merchant (owner or finance) wants to ask a customer for money.

**User actions:**
1. Go to **Payment links**, click **New payment link**.
2. Enter amount in BHD (up to three decimals), optional reference and description, expiry date and time. Click **Create payment link**.
3. On the detail page click **Copy link** and send it to the customer.

**Frontend route:** `/dashboard/payment-links` -> `/dashboard/payment-links/new` -> `/dashboard/payment-links/:id`.

**Backend endpoint:** `POST /v1/merchants/:merchantId/payment-links` `{amountFils, reference?, description?, expiresAt}` (owner/finance; a `support` user gets 403).

**DB changes:** `INSERT payment_links` (status `active`, token `plink_` + 22 random characters from `crypto.randomInt`, amount in fils, expiry, created-by type and id).

**Success outcome:** 201 with the link and its `url` (`CHECKOUT_BASE_URL` + `/pay/<token>`). The page opens the link's detail screen.

**Failure cases:** 400 `invalid_request` (amount or expiry missing), `invalid_amount` (not a positive integer fils amount), `invalid_expiry` (not in the future); 403 for `support` role or wrong merchant id. The page also stops you earlier if the BHD text is invalid, the amount is zero, or the expiry is in the past.

**Implementation status:** Working (code-read, not run). Link can be canceled later with `DELETE /v1/merchants/:merchantId/payment-links/:id` (409 `not_cancelable` if already paid, canceled or mid-payment).

---

## Flow 6: Customer checkout

**Starting point:** The customer opens the link the merchant sent.

**User actions:**
1. Open `/pay/<token>`; see the merchant name and amount.
2. Enter card number, expiry month and year, CVV; click **Pay X BHD**.
3. On decline, fix the card and try again.

**Frontend route:** `/pay/:token` (`CheckoutPage.tsx`). Public: no login and no auth calls.

**Backend endpoints:** `GET /v1/payment-links/:token` (read), `POST /v1/payment-links/:token/pay` (header `Idempotency-Key` required).

**DB changes (on a successful payment):**
1. `UPDATE payment_links` -> `reserved` (atomic claim).
2. `INSERT idempotency_keys`.
3. Authorize: `INSERT transactions` (`authorized`), `INSERT holds` (`active`, 7 days), `INSERT transaction_events` (`authorized`).
4. Capture (full amount): `UPDATE transactions` -> `captured`; `INSERT ledger_entries` (gross pair, fee pair); `UPDATE holds` -> `released`; `INSERT outbox_events` (`transaction.captured`); `INSERT transaction_events` (`captured`); `merchant_daily_volume` upsert.
5. Discount adjustment if the merchant has a negotiated discount (more `ledger_entries`).
6. `UPDATE payment_links` -> `paid` with `paid_at` and `transaction_id`.

**Success outcome:** 200 `{status:"paid", transactionId, amountFils, paidAt}`; the page shows "Payment successful" with the transaction id and time.

**Audit changes:** the page no longer sends the browser clock (`submittedAt` is honoured only for an API key of the link's owner), ignores a second click while a request runs, the public `GET` no longer returns the API key hash (`merchantIntegrationId` is the merchant id), and a "mark paid" that matches 0 rows is reconciled: same transaction -> idempotent 200, different transaction -> `409 payment_link_double_charge`, and a throw in authorize/capture releases the reservation. Fixed in code, covered by unit tests on a real database, not exercised in a live browser.

**Failure cases:** 402 (declined at authorize or capture; link returns to `active` so the customer may retry); 429 `rate_limited` (20 per minute per IP and link); 502 acquirer unavailable (retryable); 409 `payment_link_already_paid`, `payment_link_canceled`, `payment_link_processing`; 410 `payment_link_expired`; 404 not found; 403 `merchant_not_approved` / `merchant_inactive`; 400 missing idempotency key or card; 422 `idempotency_key_reused`. Simulated card rules: PAN ending `0002` always declines; `0119` insufficient funds; `0069` acquirer error; anything else approves.

**Implementation status:** Working (code-read, not run). The reviewer concern (FP-198) about a slow capture was analysed by an audit agent: a true double charge does not occur because a re-claimant reuses the same idempotency keys and replays the same transaction; the two real defects it found are fixed (see above).

---

## Flow 7: Authorization and capture

This flow covers the two-step card payment explained as merchant actions. A card payment is first **authorized** (funds held on the card) and then **captured** (funds actually taken). The checkout in Flow 6 does both back to back. A merchant integrating by API, or using the dashboard, can do them separately.

**Starting point:** (a) A merchant's server holds an API key, or (b) a transaction already exists in status `authorized` or `partially_captured`.

**User actions:**
1. (Server to server) `POST /v1/transactions` with `Authorization: Bearer <api key>`, header `Idempotency-Key`, body `{amountFils, card, reference?}`. `amountFils` must be a whole number from 1 to 99,999,999,990 (else 400 `invalid_amount` / `amount_too_large`, before any acquirer call). The acquirer receives a stable key derived from the caller's key, so a retry after an ambiguous error is safe. There is no dashboard screen for authorizing.
2. In the dashboard open the transaction (`/dashboard/transactions/:id`), click **Capture**, type an amount in fils (blank captures everything left), click **Capture**. Or click **Void** to cancel an uncaptured authorization.

**Frontend route:** `/dashboard/transactions/:id` for capture and void.

**Backend endpoints:** `POST /v1/transactions` (API key only), `POST /v1/transactions/:id/capture` (needs `Idempotency-Key`; session with role owner or finance, or API key), `POST /v1/transactions/:id/void` (no idempotency key needed; owner/finance session or API key).

**DB changes:**
- Authorize: `transactions` (`authorized`, `captured_fils=0`), `holds` (7-day expiry), `transaction_events`, `idempotency_keys`.
- Capture: as in Flow 6 step 4; partial capture gives `partially_captured` and keeps the hold until fully captured. Fee = amount x (effective MDR bps minus the platform volume-tier bonus bps), integer arithmetic. Effective MDR comes from `fee_schedules` if a negotiated schedule applies, else `merchants.mdr_bps`.
- Void: `UPDATE transactions` -> `voided`; `UPDATE holds` -> `released`; `transaction_events` (`voided`); `outbox_events` (`transaction.voided`). No acquirer call.

**Success outcome:** Authorize 201 with the transaction. Capture 200 with updated `capturedFils` and status. Void 200 (a second void of an already voided transaction also returns 200 and does nothing).

**Failure cases:** authorize 402 `card_declined` (with reason), 502 `acquirer_unavailable`, 403 `merchant_not_approved`/`merchant_inactive`; capture 404 `transaction_not_found`, 409 `not_capturable`, 422 `capture_exceeds_remaining` (response includes `remainingFils`), 402 `card_captured_declined`, 502; void 409 `not_voidable` (only `authorized` can be voided; partially captured cannot); 400 `idempotency_key_required`.

**Implementation status:** Working (code-read, not run). Capture and void now require merchant role owner or finance for session users, so a `support` session gets 403 (fixed in code, covered by unit tests, not exercised in a live browser). API keys have no role and still pass every role check (open finding S-8). Admin impersonation sessions are refused for writes. Malformed ids return 400/404, not 500. Open: after a hold expires the authorization can still be captured (F-4).

---

## Flow 8: Transaction viewing

**Starting point:** A merchant user (any role) wants to find a payment.

**User actions:**
1. Open **Transactions** (`/dashboard/transactions`).
2. Tick statuses, set From/To dates, type in the search box.
3. Click a date to open the detail page; read the event timeline.

**Frontend route:** `/dashboard/transactions`, `/dashboard/transactions/:id`.

**Backend endpoints:** `GET /v1/transactions` (filters `status`, `from`, `to`, `search`, `limit`, `cursor`), `GET /v1/transactions/:id`, `GET /v1/transactions/:id/events`. Also available but with no screen: `GET /v1/transactions/export` (CSV, window up to 31 days).

**DB changes:** None (read only): `transactions`, `transaction_events`.

**Success outcome:** A paged table (25 per page) and a detail page with amounts, references and a time-ordered event history (authorized, captured, voided, ...).

**Failure cases:** 401 if the session expired (page redirects to login); 404 for an id that is not yours ("Transaction not found"); 403 never for reads. Date filters from the page now start at Bahrain midnight (`bahrainDayStartIso`), matching the settlement business day (before the audit they were cut at UTC midnight). A malformed `limit`, date or cursor returns 400.

**Implementation status:** Working (code-read, not run).

---

## Flow 9: Full refund

**Starting point:** A merchant wants to return the whole captured amount of a payment to the customer.

**User actions (as designed):** Open the transaction, click **Refund**, leave the amount blank, confirm.

**Frontend route:** `/dashboard/transactions/:id` should show the refund button, but it does not.

**Backend endpoint:** The only refund route registered is `POST /v1/refunds` (`apps/api/src/routes/refunds.ts`); it requires merchant auth and then always answers **501 `{"error":"not_implemented"}`**. This is unchanged by the audit and intentional until the refund decisions are made. `RefundDrawer.tsx` is fully commented out and imported nowhere; its old code called `POST /v1/merchants/<merchantId>/refunds`, a route that does not exist.

**DB changes:** None can happen through the API today. For reference, a finished helper `payments/processRefund.ts` (called by `refunds/initiateMerchantRefund.ts`) is written to: insert a `refunds` row (migration 0042), set `transactions.refunded_fils` and status (`partially_refunded`/`refunded`), post reversing `ledger_entries` including a fee reversal, and honor a per-merchant hold flag `merchants.refunds_enabled`. No route calls it. The audit fixed two things in the helper (a blank reason becomes `unspecified`; the merchant-ownership check now happens inside the locked read) and left the rest for a decision: the status after a full refund of a partial capture, fee reversal vs the volume-tier bonus, route role/scope checks, and the fact that refunds are never deducted from payouts (F-1).

**Success outcome:** Not reachable. No refund can complete from the UI or the API.

**Failure cases:** Every call to `POST /v1/refunds` returns 501 (401 first if not authenticated). A test asserts the 501.

**Implementation status:** **Not Implemented** via API (code-read, not run). Helper-layer fix only.

---

## Flow 10: Partial refund

**Starting point:** A merchant wants to refund part of a captured amount.

**User actions (as designed):** Open the transaction, click **Refund**, type an amount in fils, confirm.

**Frontend route / backend endpoint / DB changes:** Same as Flow 9; the same dead end applies. The (parked) drawer's amount box allows a maximum equal to the captured amount, and the helper code is written to track the running refunded total per transaction.

**Success outcome:** Not reachable.

**Failure cases:** 501 on `POST /v1/refunds`. The status filter on the Transactions list offers `partially_refunded` and `refunded`, but nothing in the running system can set those statuses (except the admin "Recompute statuses" button, which re-derives them from any `refunded_fils` values that already exist).

**Implementation status:** **Not Implemented** via API (code-read, not run).

---

## Flow 11: End-of-day settlement

**Starting point:** The Bahrain business day ends (00:00 Asia/Bahrain, UTC+3, no daylight saving). A background daemon wakes up periodically.

**User actions:** None for the normal case; it is automatic. (Staff can trigger the same thing manually in Flow 21.)

**Frontend route:** None to trigger it. Results appear on the merchant's `/dashboard/settlement` and `/dashboard/settlement/:id`.

**Backend endpoint / process:** The Go settlement daemon (`apps/settlement/internal/scheduler/daemon.go`). After the configured run delay past local midnight (default 15 minutes, so about 00:15 Bahrain) it calls `RunDailyBatch` for *yesterday* (Bahrain date), for every merchant that is `status='active'` and `test_mode=false`. The audit fixed a bug where the daemon passed a raw UTC instant to the date-only window function: the delay was never honoured and the real close landed near 03:00 Bahrain (`BusinessDayStartAt` and `dueBusinessDate` now convert to Bahrain time first). Each merchant is settled on its own (`settleOneMerchant`): a failing merchant is logged and skipped and a `BatchFailuresError` lists the failures at the end. Re-running is safe: a batch already closed or paid is skipped. Afterwards it calls `EnqueuePayoutNotifications`.

**DB changes (per merchant, in `CloseBatch`, one transaction):**
- `INSERT settlement_batches` (`open`) if missing, then lock it.
- Select all `transaction_events` of type `captured`/`partially_captured` in the Bahrain day window `[00:00, next 00:00)` with no batch yet.
- Compute, in integers, the gross and the fee per transaction (effective MDR at the capture time minus the tier bonus recorded on the event, and any negotiated discount) and the net payout (gross minus fee).
- `UPDATE settlement_batches` -> `closed` with gross, fee, net, `closed_at`.
- `UPDATE transaction_events SET settlement_batch_id`.
- `INSERT scheme_export_lines` (one per transaction; amount truncated to the card scheme's two-decimal precision, up to 9 fils lower) and rounding-residue `ledger_entries` (debit `scheme_rounding_residue` / credit `card_scheme_clearing`).
- `INSERT outbox_events` (`settlement.batch_closed`).
- `merchant_balances.cached_payable_fils += net payout`.
- Platform volume tracking (`platform_stats`) for the volume-tier discount.

**Success outcome:** A batch with status `closed`, immediately followed by payout (Flow 12). The merchant sees it on the Settlement page.

**Failure cases:** A merchant that is inactive or in test mode is skipped (`ErrMerchantNotEligible`). If the daemon is down for several days it only catches up the most recent day automatically; older dates must be run manually (CLI `run-batch --date=` or Flow 21). The old startup-before-delay problem is fixed (the startup run also checks the delay). A permanently failing merchant is retried every poll with no alert. When `RunDailyBatch` reports a partial failure the daemon logs it and still runs `EnqueuePayoutNotifications`, so `settlement.paid` events for the paid batches are not held back (fixed during the audit). Known gap: 2 stale tests in Go `internal/ledger` still fail (the code is right).

**Implementation status:** Working / Not Verified (code-read, not run). Fixed in code, covered by unit tests, not run against a live clock. Open finding F-1: refunds, credits and adjustments are not deducted from the payout.

---

## Flow 12: Merchant payout

**Starting point:** A batch is `closed` (Flow 11).

**User actions:** None. The daemon runs `PayoutBatch` right after `CloseBatch`. The merchant checks the Settlement page.

**Frontend route:** `/dashboard/settlement` (status `paid`), `/dashboard/settlement/:id`.

**Backend endpoint / process:** Go `PayoutBatch` (or `PayoutSplitBatch` for merchants that split payouts to child merchants). No API call from the website.

**DB changes (one transaction):**
- If net payout is above zero: `INSERT ledger_entries` (debit `merchant_payable` / credit `platform_cash`, "settlement payout: batch paid").
- `UPDATE merchants` lifetime payout monitoring estimate.
- `UPDATE settlement_batches` -> `paid`, `paid_at = now()`.
- `INSERT settlement_payout_disbursements` (reference `disb_<uuid>`; unique per batch).
- `merchant_balances.cached_payable_fils -= net payout`.
- Later, `EnqueuePayoutNotifications` inserts `settlement_paid_notification_claims` and an `outbox_events` row `settlement.paid` (one per paid batch with a nonzero payout) which the webhook dispatcher sends to the merchant (Flow 15) and the reporting worker uses for the payout trend.

**Success outcome:** The batch shows `paid`. In this repository "paid" means the bookkeeping is complete and a disbursement reference was recorded; **there is no connection to a real bank**, so no real money moves.

**Failure cases:** A batch that is not `closed` is a no-op (reported `NotClosed`); a batch already `paid` is a no-op (`AlreadyPaid`). A zero or negative net payout skips the ledger payout legs. If staff trigger the run through the admin console, the notification step is not part of that HTTP handler (only the daemon and the CLI call it), so the `settlement.paid` event appears the next time the daemon wakes.

**Implementation status:** Working for bookkeeping (code-read, not run); actual bank payout: Not Implemented (simulated).

---

## Flow 13: Reconciliation

**Starting point:** An owner or finance user wants to prove that the money in the ledger matches what settlement paid and what is still waiting.

**User actions:**
1. Open **Reconciliation** (nav link hidden from `support`).
2. Keep or change the From / To (exclusive) dates (default: last 30 Bahrain days).
3. Click **Run report**.

**Frontend route:** `/dashboard/reconciliation`.

**Backend endpoint:** `GET /v1/settlement/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD` (owner/finance). A sibling `GET /v1/settlement/summary` exists with no page.

**DB changes:** None (read only): `ledger_entries` (account `merchant_payable`), `settlement_batches`, `transaction_events`, `transactions`.

**Success outcome:** Either the green "Reconciled - no gap" or "Gap: X BHD", with the four numbers (ledger payable net, settlement net payout, pending not yet batched, gap). Gap = ledger payable - settlement net payout - pending unbatched.

**Failure cases:** 403 for `support` (page shows a permission message); 400 `invalid_request` if a date is missing; wrong merchant impossible (scope is the session).

**Implementation status:** Not Verified (code-read, not run). The wiring is consistent, but whether the numbers always reconcile (for example for merchants with negotiated discounts, or after admin cache-only balance adjustments, which do not touch the ledger) was not tested; developer comments in the code disagree about whether the gap is "always 0".

---

## Flow 14: Webhook configuration

**Starting point:** An owner or finance user wants FilsPay to notify their server about payments.

**User actions:**
1. Open **Webhooks** (hidden from `support`), click **New endpoint**.
2. Enter an HTTPS URL, click **Create endpoint**.
3. **Copy the signing secret now** (shown once), click "I've saved it - continue".
4. On the endpoint page click **Send test event** to check the receiver answers.
5. Later: **Disable / Enable** or **Delete** from the list.

**Frontend route:** `/dashboard/webhooks`, `/dashboard/webhooks/new`, `/dashboard/webhooks/:id`.

**Backend endpoints (all owner/finance):** `POST /v1/merchants/:merchantId/webhook-endpoints`, `GET` (list), `PATCH .../:id` `{url?, status?}`, `DELETE .../:id`, `POST .../:id/test`.

**DB changes:**
- Create: `INSERT webhook_endpoints` (URL, encrypted secret `secret_ciphertext`, display `secret_prefix`, status `active`, created-by).
- Update: `UPDATE webhook_endpoints` (URL/status).
- Delete: `UPDATE webhook_endpoints SET status='disabled', deleted_at=now()` (a soft delete; delivery history is kept even though the dialog says "cannot be undone"). Deleted endpoints now return 404 on test-send and detail.
- Test event: nothing is written (synchronous send of `test.ping`).

**Success outcome:** The endpoint is `active` and listed. From now on new events go to it (only events created *after* the endpoint was registered).

**Failure cases:** 400 `invalid_url` (not http/https; in production must be https, and the host's DNS answers must not be private or internal addresses, checked against a wider blocklist); 403 for `support` or another merchant's id; 404 `webhook_endpoint_not_found`; the test button reports "The receiver could not be reached" on a timeout or connection failure.

**Implementation status:** Working (code-read, not run).

---

## Flow 15: Webhook delivery and retry

**Starting point:** A payment event is written to the outbox (for example `transaction.captured`).

**User actions:** None for delivery. Merchants can read the **Delivery log** and click **Replay**; admins can batch replay (Flow 15 sidebar below).

**Frontend route:** `/dashboard/webhooks/:id` (log, replay, test). Admin: `/webhooks/:merchantId`.

**Backend endpoint / process:** The dispatcher (`webhooks/dispatcher.ts`) runs in the API process when started by `index.ts` (listens for a Postgres NOTIFY on `outbox_events_channel`, and also polls every 5 seconds by default). Each pass has two steps:
- **Step A, create:** for every `outbox_events` row of type `transaction.captured`, `transaction.voided` or `settlement.paid` and every *active* endpoint of that merchant (endpoint created before the event), insert one `webhook_deliveries` row in status `pending`, with the event wrapped in an envelope.
- **Step B, attempt:** claim due `pending` rows (with a claim token and lease so two workers do not send the same delivery), decrypt the endpoint secret, sign the exact JSON body with HMAC-SHA256 (re-signed with a fresh timestamp on each attempt), and POST it with headers `Webhook-Signature: t=<unix seconds>,v1=<hex>` and `Webhook-Delivery-Id`, timing out after 10 seconds. In production the transport (`node:http`/`https`) resolves the host, rejects private addresses and pins the connection to the vetted IPs; redirects are never followed.

**DB changes:**
- Success (HTTP 2xx): `status='succeeded'`, `attempt_count+1`, response code and first 2000 characters of the body saved.
- Failure (non-2xx, timeout, connection error): `attempt_count+1`, response saved, `next_attempt_at = now() + delay` where delay = 30 s x 2^(attempt-1), capped at 6 hours, with plus or minus 10% jitter. Status stays `pending`.
- After **8** total attempts (default `WEBHOOK_MAX_ATTEMPTS`): `status='exhausted'`. The status `failed` exists in the table's check constraint and in the UI filter, but the dispatcher never sets it.
- Replay (merchant button or admin batch): `INSERT webhook_deliveries` (a new pending row, `replay_of_delivery_id` pointing to the original, a **new** `delivery_event_id` written into the payload `id`, `next_attempt_at=now()`); sent on the next pass. `docs/ADMIN.md:89` is wrong where it says the id is reused.

**Success outcome:** The merchant's server answers 2xx and the log shows `succeeded`.

**Failure cases:** Server down or slow gives retries then `exhausted`; replay needs an *active* endpoint (409 `endpoint_disabled` otherwise); a disabled endpoint stops receiving new deliveries and pending ones are not claimed. Only three event types are delivered; there are no webhook events for authorization, refund or batch closed. `refund.succeeded` is deliberately not in the eligible list. Two locked dispatcher tests still fail (they expect exact backoff without jitter and attempt count 0 for a poisoned row).

**Implementation status:** Working (code-read, not run). Operational note: the dispatcher is started by the API entry point, not by `buildApp()`; if the API process is not run with it, nothing is delivered.

---

## Flow 16: Admin login

**Starting point:** A FilsPay staff member opens the admin console at `http://localhost:5174`.

**User actions:** Enter email and password, click **Continue**, enter the OTP, click **Verify**.

**Frontend route:** `/login` (admin app), then `/merchants`.

**Backend endpoints:** `POST /v1/admin/auth/login`, `POST /v1/admin/auth/otp/verify`, `GET /v1/admin/auth/me`, `POST /v1/admin/auth/logout`. There is no resend endpoint.

**DB changes:** `INSERT admin_otp_challenges`, `INSERT admin_sessions` (pending). On verify: challenge consumed, session promoted; the token is **rotated** (the cookie value changes) only when `ROTATE_SESSION_ON_OTP_VERIFY` is on (default ON in production, OFF elsewhere), cookie `fp_admin_sid` re-set. Logout revokes the session. Admin login is limited to 10 per minute per IP and email.

**Success outcome:** `{authenticated:true, adminUserId, role}`; the console shows your email and role chip.

**Failure cases:** 401 `invalid_credentials`; 401 `invalid_code`; 410 `otp_expired`; 429 `too_many_attempts`; 401 `no_pending_session`; 503 `otp_delivery_unavailable`. Admin users with status `disabled` cannot log in and lose active sessions.

**Implementation status:** Working (code-read, not run).

---

## Flow 17: Admin merchant approval

**Starting point:** An admin wants to clear the review queue (many merchants at `under_review`) or review one merchant.

**User actions:**
- One at a time: Flow 3.
- In bulk: open **Merchants**, tick the `under_review` status filter, tick merchants (or the select-all box), click **Bulk approve KYC**.

**Frontend route:** admin `/merchants` (bulk) and `/merchants/:id` (single).

**Backend endpoints:** `GET /v1/admin/merchants?q=&onboardingStatus=&limit=&cursor=` (any admin), `POST /v1/admin/merchants/bulk-approve` `{merchantIds, notes?}` (finance/super_admin; 1 to 200 ids).

**DB changes (one transaction):** for each merchant that is currently `under_review` (locked `FOR UPDATE`): `INSERT merchant_kyc_reviews` (approved) and `UPDATE merchants` -> `approved`, `kyc_passed=true`; then one `INSERT admin_audit_log` (`kyc_bulk_approve`) listing requested, approved and skipped ids.

**Success outcome:** Notice "Approved KYC for N merchant(s)." and the list refreshes. The response also lists `skippedMerchantIds` (not found, or not in `under_review`), but the page only displays the approved count. There is no confirm dialog, and a single approve (Flow 3) has no status or document precondition (open decision S-4).

**Failure cases:** 400 for empty list, more than 200 ids, or a non-UUID id; 403 for `support`. Bulk approval does not look at documents or allow rejection; use the single flow to reject.

**Implementation status:** Working (code-read, not run).

---

## Flow 18: Admin credit creation and approval

**Starting point:** An admin wants to give a merchant a manual credit (goodwill, dispute resolution, correction).

**User actions:**
1. Admin A: on `/merchants/:id`, section **Issue credit**: amount in BD (up to 3 decimals), reason, effective date, optionally tick "Also reverse the MDR", memo; click **Issue credit**.
2. If the credit is large, Admin B (a different finance or super_admin): open **Credits**, tab **Awaiting approval**, click **Approve** (or **Reject** and give a reason).

**Frontend route:** admin `/merchants/:id`, then `/credits`.

**Backend endpoints:** `POST /v1/admin/merchants/:id/credits` (finance/super_admin), `GET /v1/admin/credits?status=` (any admin), `POST /v1/admin/credits/:creditRequestId/approve`, `POST .../reject` `{reason?}` (finance/super_admin).

**DB changes:**
- Create: `INSERT credit_requests` (`pending_approval`; fee reversal = base x merchant `mdr_bps` if ticked) and `admin_audit_log` (`credit_request_created`).
- If base amount is **50,000 fils (50.000 BD) or less**: it posts at once: `INSERT ledger_entries` (debit `merchant_credit_contra` / credit `merchant_payable` for the base, plus debit `platform_fee_revenue` / credit `merchant_payable` for any fee reversal; dated at Bahrain midnight of the effective date, not `now()`), `merchant_balances.cached_payable_fils +=` total, `credit_requests` -> `posted` with `ledger_entry_group_id` and `posted_at`.
- Above 50 BD: waits. Approve: same ledger postings, plus approver id/time, audit `credit_request_approved`. Reject: status `rejected`, `rejected_by_admin_user_id`, `rejected_at`; audit `credit_request_rejected` (the reason is stored only in the audit metadata).

**Success outcome:** Posted credit increases the merchant's payable and appears in the ledger.

**Failure cases:** 400 invalid amount/reason/date (validation in `creditRequestValidation.ts`); 404 `merchant_not_found` or `credit_request_not_found`; 409 `credit_request_not_pending`; the approver may not be the person who raised the credit (four-eyes rule, `assertDistinctApprover`; compared by **admin user id**, 409 `self_approval_forbidden`, display names are ignored since the audit); 403 for `support`.

**Implementation status:** Working (code-read, not run).

---

## Flow 19: Admin balance adjustment

There are two admin ways to change a merchant balance directly.

**Starting point:** Support has confirmed the merchant's balance figure is wrong.

**User actions:**
- Single: on `/merchants/:id`, section **Adjust balance**: delta in fils (may be negative; `1e3` and `0x10` are rejected by the page), reason; click **Adjust balance**.
- Bulk: `/adjustment-imports`: paste CSV `merchantId,amount,reason` (amount in BD, e.g. `4.750`), click **Apply**; open **View rows** later to audit.

**Frontend route:** admin `/merchants/:id`; admin `/adjustment-imports`.

**Backend endpoints:** `POST /v1/admin/merchants/:id/balance-adjustments` `{deltaFils, reason}` (finance/super_admin); `POST /v1/admin/adjustment-imports` `{csvContent, originalFilename?}`, `GET /v1/admin/adjustment-imports`, `GET /v1/admin/adjustment-imports/:id/rows`.

**DB changes:**
- Single (changed in the audit): the route calls `adjustMerchantBalanceJournaled`. In one transaction it locks the `merchant_balances` row (404 `merchant_balance_not_found` if missing), posts a balanced `ledger_entries` group (`postLedgerAdjustment`), updates `cached_payable_fils += delta` and inserts `admin_audit_log` with action `balance_adjustment_journaled` (before, after, entry group id). Because the ledger is updated, a later "Rebuild balances" (Flow 21) keeps the adjustment. A delta or resulting balance outside the safe range returns 400 (it was 500).
- Bulk CSV: `INSERT adjustment_imports` and `adjustment_import_rows` (raw text beside the parsed integer fils), balanced `ledger_entries` per row, and `merchant_balances` updates. Duplicate files are rejected by content hash (migration 0073). A reason containing commas is kept whole (it used to be cut at the third comma).

**Success outcome:** Single: notice "Balance adjusted by X BHD: before -> after". CSV: "Applied N row(s), posting X BHD in total."

**Failure cases:** 400 `invalid_request` (delta zero, not an integer, empty reason, out of range), `invalid_csv_row` (not a merchant UUID; an unknown merchant id may return 500, unverified); 404 merchant or balance not found; 403 for `support`.

**Implementation status:** Working (code-read, not run). Single adjustment: fixed in code, covered by 4 new tests on a real database (they failed before the fix, because a rebuild returned 0 instead of the adjustment), not exercised in a live browser. Caveats: the audit action name changed from `balance_adjustment` (consumers must treat both as one event); about 25 earlier cache-only adjustments are probably already lost to rebuilds (a finance decision); the CSV import has no threshold, second approver or row cap (open decision S-5); 4 locked CSV unit tests still fail because they assume 100 units per BD.

---

## Flow 20: Admin impersonation

**Starting point:** An admin needs to see what a merchant sees ("View as merchant").

**User actions:** On `/merchants/:id` click **View as merchant**; a new tab opens the merchant app. Later click **Exit impersonation** in the red banner.

**Frontend route:** admin `/merchants/:id`; merchant app `http://localhost:5173`; the admin console shows "Admin screens are paused" while a grant is active.

**Backend endpoints:** `POST /v1/admin/merchants/:id/impersonate` (any admin role, including `support`), `POST /v1/admin/impersonation/:grantId/end` (any admin).

**DB changes:** `INSERT admin_impersonation_grants` (hashed token, expiry now + 15 minutes by default) and `admin_audit_log` (`impersonation_start`); sets cookie `fp_impersonation`. End: `ended_at` set, audit `impersonation_end`, cookie cleared. The admin console no longer clears its banner if the end call fails.

**Success outcome (admin side):** A grant exists, is audited, shows in the banner, and expires on its own. The grant is read-only: `requireMerchantAuth` rejects any non-GET request that relies on the impersonation cookie, and write actions refuse that actor type. Since the audit **every admin role maps to merchant role `support`** (before, `super_admin` mapped to `owner` and `finance` to `finance`), matching `HANDOVER.md` and `ADMIN.md`.

**Failure cases:** 404 `merchant_not_found`; 404 `impersonation_grant_not_found` on end; the browser may block the pop-up tab (the page then shows a link). **"View as merchant" does not work end to end (finding D-1, from reading the code, not run live):** the merchant dashboard decides whether you are logged in by calling `GET /v1/auth/me`, and that route only accepts a real merchant session cookie (`requireSession`), not the impersonation cookie. A dashboard code comment even says impersonation does not exist in the merchant plane. So the merchant app shows its own login page rather than the merchant's data. Open decisions: let `/me` accept the grant (plus UI work), and who may start impersonation (any admin role can; `CLAUDE.md`'s `super_admin` middleware check does not exist).

**Implementation status:** Role mapping: fixed in code, covered by unit tests (the finance case failed with the old mapping), not exercised in a live browser. Feature as a whole: **does not work end to end** (D-1).

---

## Flow 21: Admin settlement re-run (and related ops)

**Starting point:** A day's batch was missed, or numbers need rebuilding.

**User actions:** Admin console **Settlement ops**:
- **Re-run a daily batch:** choose the business date, optionally a merchant id, click **Run batch**.
- **Rebuild balances** (confirm). **Rebuild analytics** (confirm). **Recalculate MDR** (merchant id, From, To).

**Frontend route:** admin `/settlement`.

**Backend endpoints (finance/super_admin):** `POST /v1/admin/settlement/run-batch`, `POST /v1/admin/balances/rebuild`, `POST /v1/admin/reporting/rebuild`, `POST /v1/admin/merchants/:id/mdr-recalculation`. The API forwards the first, second and fourth to the Go service's internal endpoints (`/internal/run-batch`, `/internal/rebuild-balances`, `/internal/recalculate-mdr`) using a bearer token.

**DB changes:**
- Audit first: `INSERT admin_audit_log` (committed *before* the call; if this fails the action does not run), then updated to `succeeded` or `failed` after.
- Run batch: same as Flows 11 and 12 for the chosen date (idempotent; already-closed and already-paid batches are reported, not repeated).
- Rebuild balances: `merchant_balances` recomputed from `ledger_entries` (the authority).
- Rebuild analytics: truncates and replays `merchant_daily_volume` and `merchant_payout_trends` from the outbox, inside the API process, in one transaction.
- Recalculate MDR: re-derives fees for `closed` batches in the range at the current rate and posts adjustments; paid batches are untouched.

**Success outcome:** Result tables on the page (per-merchant gross/fee/net with "already closed/paid" flags; changed balances before/after; rebuilt row counts; fee differences).

**Failure cases:** 400 `invalid_request` (date not `YYYY-MM-DD`, merchant id not a UUID, MDR dates missing); 403 for `support`; 5xx or a connection error if the Go service is down or the token is wrong (the audit row then records `failed`); HTTP 500 `run_batch_partial_failure` with a `failedMerchants` list when at least one merchant failed even though the others were settled (the page shows an error). Admin date fields now default to Bahrain dates.

**Implementation status:** Partially Working / Not Verified (code-read, not run): depends on the Go service being reachable (in production the API and Go service refuse the built-in `dev-token`); the 2 stale Go `internal/ledger` tests still fail (the code is right). Any admin role can trigger webhook replays (S-21).

---

## Flow 22: Reporting and analytics

**Starting point:** A merchant wants a view of volumes, payouts and best-selling links.

**User actions:** Open **Overview**, optionally set From / To dates and "Top links" count, click **Refresh** (it also refreshes itself every minute).

**Frontend route:** `/dashboard/overview`.

**Backend endpoints (any merchant role):** `GET /v1/analytics/volumes`, `GET /v1/analytics/payout-trends`, `GET /v1/analytics/top-links?limit=` (dates `YYYY-MM-DD`, `to` exclusive; default last 30 Bahrain days). Not used by any page: `GET /v1/analytics/recent-ledger-activity`, `GET /v1/reporting/transactions`, `POST/GET /v1/reporting/saved-filters`, `GET /v1/reporting/export-summary`, `GET /v1/transactions/export`.

**DB changes by the page: none.** Behind the scenes, the reporting worker (`apps/reporting`) consumes `outbox_events` of types `transaction.captured`, `transaction.voided`, `settlement.batch_closed`, `settlement.paid` and maintains `merchant_daily_volume` and `merchant_payout_trends` (advancing `reporting_outbox_cursor`). Top links are read live from `payment_links`.

**Success outcome:** Three tables with freshness badges (`readModelAsOf` / `live`) so you can tell if the read model is behind.

**Failure cases:** 400 `invalid_date` for a bad date; stale or empty numbers if the reporting worker is not running (an admin can click **Rebuild analytics** in Flow 21); 401 if the session expired.

**Implementation status:** Working (code-read, not run), provided the reporting worker runs.

---

## Summary of statuses

| # | Flow | Implementation status (code-read, not run) |
|---|---|---|
| 1 | Merchant registration | Working |
| 2 | Onboarding | Working |
| 3 | KYC approval | Working |
| 4 | Login + OTP | Working |
| 5 | Create payment link | Working |
| 6 | Customer checkout | Working |
| 7 | Authorization and capture | Working (no authorize screen; role hide not enforced by API) |
| 8 | Transaction viewing | Working |
| 9 | Full refund | **Not Implemented** via API (501) |
| 10 | Partial refund | **Not Implemented** via API (501) |
| 11 | End-of-day settlement | Working / Not Verified |
| 12 | Merchant payout | Working for bookkeeping; no real bank |
| 13 | Reconciliation | Not Verified |
| 14 | Webhook configuration | Working |
| 15 | Webhook delivery and retry | Working |
| 16 | Admin login | Working |
| 17 | Admin merchant approval | Working |
| 18 | Admin credit creation and approval | Working |
| 19 | Admin balance adjustment | Working (single adjustment now journaled; CSV has no second approver) |
| 20 | Admin impersonation | **Does not work end to end** (D-1); role mapping fixed |
| 21 | Admin settlement re-run | Partially Working / Not Verified |
| 22 | Reporting and analytics | Working (needs reporting worker) |
