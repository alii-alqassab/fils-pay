# FilsPay: Every Page Explained

A beginner's tour of every screen in FilsPay: what the user sees, what each button does, which API endpoint it calls, and which database tables are touched.

**How this document was produced.** Everything below comes from reading the source code (route tables, page components, API client files, API route handlers, SQL in the handlers and helpers, and the migrations). Nothing was run in a browser. Wherever a status says "code-read, not run", that is what it means: the behaviour is what the code says it should do, not something that was observed.

**Refreshed on 2026-10-30 for the final state after the audit fixes.** Fixes made by audit agents are described as "fixed in code, covered by unit tests, not exercised in a live browser". The audit's own tracker is `docs/audit/AGENT_TASKS.md` and its new findings are in `docs/audit/DISCOVERY_FINDINGS.md`.

**Companion document:** `COMPLETE_USER_FLOWS.md` in this folder follows whole journeys (register, pay, settle, refund) across several pages.

---

## 0. Read this first: the big picture

### 0.1 The three apps you can see in a browser

| App | Folder | Dev address | Who uses it |
|---|---|---|---|
| Merchant dashboard + public checkout | `apps/web` | `http://localhost:5173` | Merchants (shop owners) and their customers |
| Admin console | `apps/admin` | `http://localhost:5174` | FilsPay staff |
| API (the backend both apps talk to) | `apps/api` | `http://localhost:3000` | Not a website; JSON over HTTP |

Behind the API there are two more processes that have no web pages but matter for the flows: the Go **settlement service** (`apps/settlement`, closes the day's batches and records payouts) and the **reporting worker** (`apps/reporting`, builds the read-model tables the Overview page reads).

### 0.2 Units of money: read this twice

**1 BD (Bahraini Dinar) = 1000 fils.** Every amount in the API, the database and the page code is an integer number of fils. The pages show them as BD with three decimals, using `formatBhd` from `packages/money`. Example: `10750` fils is shown as `10.750 BHD`.

(The repo's `CLAUDE.md` and `AGENTS.md` describe the amounts as "integer cents". That is wrong for this code: the `Fils` type, the `*_fils` column names, the three-decimal display and the checks in the pages all agree on fils. This document trusts the code.)

### 0.3 How login works (merchant and admin are two separate worlds)

Both logins are two steps: **password, then a one-time code (OTP)**.

| | Merchant dashboard | Admin console |
|---|---|---|
| Cookie name (default) | `fp_sid` | `fp_admin_sid` |
| Tables | `merchant_users`, `sessions`, `otp_challenges` | `admin_users`, `admin_sessions`, `admin_otp_challenges` |
| Roles | `owner`, `finance`, `support` | `support`, `finance`, `super_admin` |
| Session length once verified | 12 hours (`SESSION_TTL_HOURS`) | 8 hours (`adminSessionTtlHours`) |
| OTP | 6 digits from `crypto.randomInt`, valid 5 minutes, 5 wrong tries then the session is revoked; the attempt budget carries across resends | same pattern, admin settings |
| Resend code | Yes (`/v1/auth/otp/resend`, at most once per 30 seconds) | No resend endpoint exists |
| Session token at OTP verify | Replaced by a new token only when `ROTATE_SESSION_ON_OTP_VERIFY` is on (default ON in production, OFF elsewhere) | same switch |
| Rate limit | login 10/min per IP+email; OTP 10/min per IP | login 10/min; OTP 10/min per IP |

In development the API returns the OTP in the login response (`devOtpCode`) and the page prints it. In production it is emailed.

A third cookie, `fp_impersonation`, is created when an admin uses "View as merchant" (see the admin merchant detail page). **That feature does not work end to end** (finding D-1, code-read, not run): the merchant dashboard's login gate calls `GET /v1/auth/me`, which accepts only a real merchant session cookie.

### 0.4 "Hiding a button" is not security

Both apps hide buttons by role using a `RequireRole` component. That is only for convenience. The API checks the role again on every request (`requireRole`, `requireMerchantRole`, `requireAdminRole`). A few places hide a button without a matching server check; those are called out under "Validation and security".

### 0.5 Standard states every page uses

Almost every page follows this pattern, so it is not repeated in full for each page. A request that exceeds a rate limit gets HTTP 429 `rate_limited`; pages show the server message:

- **Loading:** a "Loading..." paragraph or a disabled button that changes its label ("Creating...", "Verifying...").
- **Error:** a red paragraph (`dash-error` in the dashboard, `admin-error` in the admin console) with text from `describeError(err)`. For HTTP 403 it says "Not permitted (code) ..."; otherwise it shows the server's `message` or `error` code.
- **Empty:** a table row saying "No ... match these filters."
- **Cursor pagination:** list pages show a "Load more" button (the `Pagination` component) when the API returns a `nextCursor`. The cursor is an opaque string the page passes back unchanged.

### 0.6 Status vocabulary used below

- **Working** = code path looks complete and consistent end to end.
- **Partially Working** = part of it works, part is missing or inconsistent.
- **Broken** = the code as written cannot do what the page promises.
- **Not Implemented** = the feature does not exist in the running code.
- **Not Verified** = could not be judged from code alone.
- Every status is "code-read, not run".

### 0.7 Known big gap: refunds cannot be completed

`POST /v1/refunds` (the only refund route registered in `apps/api/src/app.ts`) returns **HTTP 501 `not_implemented`** (`apps/api/src/routes/refunds.ts`; a test asserts it). The refund drawer component `RefundDrawer.tsx` is entirely commented out and imported nowhere, so the transaction page has no Refund button. The refund helper code (`payments/processRefund.ts`, `refunds/initiateMerchantRefund.ts`, table `refunds`) exists but no route calls it. The audit fixed the helper (a blank reason becomes `unspecified`; ownership is checked inside the helper) but deliberately left the route as a 501 stub, because several business decisions are open (see `AGENT_TASKS.md`, REFUND-1). This describes the final code.

---

# PART A: Merchant dashboard and public checkout (`apps/web`)

The route table lives in `apps/web/src/router.tsx`. Structure:

```
/                              -> redirect to /dashboard/login
/pay/:token                    -> CheckoutPage (public, no login, no auth calls)
<DashboardAuthProvider>        -> asks the API "who am I?" (GET /v1/auth/me) once
  /dashboard/login             -> LoginPage
  /dashboard/register          -> RegisterPage
  <RequireDashboardAuth>       -> redirects to login if not signed in
    <DashboardLayout>          -> top bar + nav, then the page
      /dashboard               -> redirect to /dashboard/transactions
      /dashboard/onboarding
      /dashboard/transactions, /dashboard/transactions/:id
      /dashboard/payment-links, /new, /:id    (new = owner/finance only)
      /dashboard/webhooks, /new, /:id         (all owner/finance only)
      /dashboard/settlement, /dashboard/settlement/:id
      /dashboard/reconciliation
      /dashboard/overview
*                              -> RouteNotFound (404 page)
```

Shared files used by almost every page: `apps/web/src/api/client.ts` (the `request()` helper; always sends cookies with `credentials: "include"`), `apps/web/src/auth/DashboardAuthContext.tsx`, `apps/web/src/auth/RequireRole.tsx`, `apps/web/src/format.ts` (`bhd()` money formatting), `apps/web/src/types.ts`.

---

### Page: Root redirect

**URL:** `/`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Send anyone who opens the bare site address to the sign-in page.

**Who can access it:** Anyone.

**What the user sees:** Nothing; the browser immediately jumps to `/dashboard/login`.

**What the user can do (every button/form/filter):** Nothing.

**Step-by-step example:** 1. Type `http://localhost:5173/`. 2. The router renders `<Navigate to="/dashboard/login" replace />`. 3. You land on the login page.

**What happens in the backend:** Nothing. This is purely a browser-side redirect.

**Database interaction:** None.

**Navigation:** Goes to `/dashboard/login`.

**Validation and security:** None needed.

**Error and loading states:** None.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/router.tsx`

---

### Page: Public checkout (customer pays a payment link)

**URL:** `/pay/:token` (example: `/pay/plink_AbC123...`; tokens are `plink_` followed by 22 random characters)

**Application:** Merchant dashboard app (`apps/web`), but it is a public page outside the dashboard login. It deliberately makes no auth calls and sends no required cookie.

**Purpose:** Let the merchant's customer see how much they owe and pay with a (simulated) card.

**Who can access it:** Anyone who has the link. No account needed.

**What the user sees:**
- While loading: "Loading...".
- If the link is unknown or the lookup fails: "Payment link not found".
- If the link is payable: the merchant's display name as the heading, the amount like `10.000 BHD`, optional description and "Reference: ...", a card form (Card number, Expiry month, Expiry year, CVV), a "Pay 10.000 BHD" button, and a help line listing the simulated test cards.
- If the link status is not payable, a single message page: "Already paid", "Link expired", "No longer available" (canceled), or "Payment processing" (another payment is being processed right now).
- After a successful payment: "Payment successful" with the Transaction ID and Paid at time.

**What the user can do (every button/form/filter):**
- Type card number (as you type, it dynamically imports `utils/helpers.js` and shows a small brand hint once 4 digits are entered).
- Choose expiry month (1 to 12) and year, type CVV.
- Click **Pay**. The page creates a fresh random idempotency key (`crypto.randomUUID()`). A synchronous guard ignores a second click while the first request is still running, and the page no longer sends the browser's clock as `submittedAt` (the server clock decides expiry). Fixed in code, covered by unit tests only for helper functions; the button behaviour was not exercised in a live browser.
- After a decline you can edit the card and press Pay again.

**Step-by-step example:**
1. The merchant shares `http://localhost:5173/pay/plink_xxx`.
2. Customer opens it; page calls `GET /v1/payment-links/plink_xxx`.
3. Customer types `4111111111111111`, 12, next year, `123`, clicks Pay.
4. Page calls `POST /v1/payment-links/plink_xxx/pay` with header `Idempotency-Key`.
5. API returns 200 `{status:"paid", transactionId, amountFils, paidAt}`; page shows "Payment successful".

Simulated card rules (from the on-page help text): any ordinary number approves; a PAN ending `0002` always declines (do not honor); ending `0119` declines (insufficient funds); ending `0069` always errors (acquirer unavailable). No real money moves; the "acquirer" is a built-in simulator.

**What happens in the backend:**
- `GET /v1/payment-links/:token` (`routes/paymentLinks.ts`, `paymentLinks/read.ts`): public; joins `payment_links`, `merchants`, and reads only the 16-character prefix of the merchant's latest unrevoked API key; computes a public status (`active`, `processing`, `paid`, `expired`, `canceled`). It no longer returns the API key hash: `merchantIntegrationId` is now the non-secret merchant id (`merchantPublicKey`, the key prefix, is still returned because a locked test expects it). No web code uses either field.
- `POST /v1/payment-links/:token/pay` (`paymentLinks/pay.ts`):
  1. Requires `Idempotency-Key` header, else 400 `idempotency_key_required`. Requires `card` in the body, else 400 `invalid_request`.
  2. `submittedAt` is honoured only when the request carries a valid Bearer API key that belongs to the merchant that owns this link (an offline-terminal flow). This page never sends one, so the server's clock decides expiry.
  3. **Claim:** one atomic UPDATE sets the link from `active` to `reserved` (or re-claims a `reserved` link whose reservation timed out), only if not expired.
  4. **Authorize:** `authorizeTransaction` calls the simulated acquirer. If approved, inserts a `transactions` row (`authorized`), a `holds` row (7-day hold), and a `transaction_events` row (`authorized`). Requires the merchant to be `onboarding_status = 'approved'` and `status = 'active'`, else 403 `merchant_not_approved` / `merchant_inactive`.
  5. **Capture:** `captureTransaction` captures the full amount: updates `transactions` (`captured`), writes balanced `ledger_entries` (gross: debit `card_scheme_clearing` / credit `merchant_payable`; fee: debit `merchant_payable` / credit `platform_fee_revenue`), releases the hold, inserts an `outbox_events` row `transaction.captured`, a `transaction_events` row `captured`, and updates the daily volume.
  6. Applies any negotiated-discount adjustment (`payments/discountAdjustment.ts`, more `ledger_entries`).
  7. **Finalize:** link becomes `paid` with `paid_at` and `transaction_id`. If that update matches 0 rows (a slow request lost its reservation), the link is re-read: same transaction means an idempotent 200; a different transaction means `409 payment_link_double_charge` plus an error log (the 409 body no longer reveals the other transaction's id); an unpaid link is finalized by id. If authorize or capture throws, the reservation is released.
  8. On a decline (402) or acquirer error (502) the link goes back to `active` so the customer can retry; a definitive decline advances the link's attempt counter.

**Database interaction:**
- Read: `payment_links`, `merchants`, `api_keys`.
- Write (on pay): `payment_links`, `idempotency_keys`, `transactions`, `holds`, `transaction_events`, `ledger_entries`, `outbox_events`, `merchant_daily_volume`.

**Navigation:** No links out. Success and terminal pages are dead ends by design.

**Validation and security:**
- Public by design; the token is the only secret (22 random characters from a 64-character alphabet, drawn with `crypto.randomInt`). Rate limit 20 pay requests per minute per IP and token.
- Browser-side: required fields, month 1-12, year not before this year. Real validation is server-side (card format checked by the simulator).
- Replays: same idempotency key and body returns the stored result; same key with a different body is 422 `idempotency_key_reused`.
- Error mapping in the page: 402 -> "Your card was declined." (or "Your payment could not be completed." if the failing stage was capture); 502 -> acquirer unavailable; 409 `payment_link_already_paid` / `payment_link_canceled` -> terminal messages; other 409 -> "already being processed"; 410 -> "expired"; anything else -> the server message.

**Error and loading states:** As above. Network failure on pay shows "Something went wrong. Please try again."

**Current implementation status:** Working (code-read, not run). The reservation race (PAY-1) was analysed by an audit agent: a true double charge does not happen through this path, because a second request reuses the same idempotency keys and replays the same transaction. Two real defects (a lost reservation returning a false "paid", and a silent 200 on a different transaction) are fixed in code, covered by unit tests on a real database with a slow acquirer stub, not exercised in a live browser.

**Relevant source files:** `apps/web/src/pages/checkout/CheckoutPage.tsx`, `apps/web/src/api/paymentLinks.ts`, `apps/api/src/routes/paymentLinks.ts`, `apps/api/src/paymentLinks/pay.ts`, `apps/api/src/paymentLinks/read.ts`, `apps/api/src/lib/rateLimit.ts`, `apps/api/src/payments/authorize.ts`, `apps/api/src/payments/capture.ts`, `apps/api/src/payments/discountAdjustment.ts`

---

### Page: Merchant sign-in (password then OTP)

**URL:** `/dashboard/login`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Let a merchant user sign in with email, password, and a one-time code.

**Who can access it:** Anyone. If already signed in, the page redirects to where you were going (`state.from`) or `/dashboard/transactions`.

**What the user sees:** Title "FilsPay dashboard", "Merchant sign-in.". Step 1: Email and Password fields, "Continue" button, link "Create a merchant account". If you just registered, a banner "Account created. Sign in to upload verification documents." and the email is pre-filled. Step 2: a message "A one-time code was issued for <email>. It expires at <time>", in development a "Development code: 123456" line, a One-time code field, **Verify**, **Resend code**, **Start over** buttons.

**What the user can do (every button/form/filter):**
- **Continue:** submit email and password.
- If the same email exists under several businesses, a **Business** dropdown appears (after a 409 `merchant_selection_required`); pick one and press Continue again. Editing email or password clears the dropdown.
- **Verify:** submit the code.
- **Resend code:** request a new code (server allows one per 30 seconds; too soon gives error `resend_too_soon`).
- **Start over:** back to step 1.
- Link **Create a merchant account** goes to `/dashboard/register`.

**Step-by-step example:**
1. Enter `owner@shop.bh` and the password; click Continue.
2. API checks password, creates a pending session and an OTP, sets cookie `fp_sid` (pending), returns `{otpRequired:true, otpExpiresAt, devOtpCode}`.
3. Type the code, click Verify. API promotes the session to authenticated (12 hours).
4. Page calls `refresh()` (`GET /v1/auth/me`), then navigates to `/dashboard/transactions`.

**What happens in the backend:** (`routes/auth.ts`)
- `POST /v1/auth/email-login`: finds `merchant_users` joined to `merchants` (active only) by case-insensitive email (optionally narrowed by `merchantId` or registration number), verifies each candidate's argon2id password. At most `LOGIN_MAX_CANDIDATES` (default 5) candidates are checked, so a person with more than 5 businesses on one email must send `merchantId` or `registrationNumber`. No match gives 401 `invalid_credentials` (a dummy hash is verified so timing does not reveal whether the email exists). More than one match gives 409 `merchant_selection_required` with the list of businesses. Otherwise, in one transaction, inserts an `otp_challenges` row and a pending `sessions` row, sends the code (email in production), sets the cookie. If sending fails: session revoked, 503 `otp_delivery_unavailable`.
- `POST /v1/auth/otp/verify`: reads the cookie, locks the session and the challenge, checks expiry (410 `otp_expired`), attempt count (429 `too_many_attempts`, session revoked), code hash (401 `invalid_code`, attempt count +1). On success marks the challenge consumed and promotes the session; with `ROTATE_SESSION_ON_OTP_VERIFY` on (default in production only) it also issues a new session token.
- `POST /v1/auth/otp/resend`: marks the old challenge consumed, issues a new one that inherits the failed-attempt count (resending never gives fresh guesses), emails it.

**Database interaction:** Read `merchant_users`, `merchants`, `merchant_business_profiles`. Write `otp_challenges`, `sessions`.

**Navigation:** On success to `redirectTo` (default `/dashboard/transactions`). Link to register.

**Validation and security:** Generic error for bad email or bad password; OTP attempts capped; login is rate limited (10 per minute per IP and email) and OTP calls 10 per minute per IP (HTTP 429 `rate_limited`, fixed in code, covered by unit tests, not exercised in a live browser); cookie is `httpOnly`, `sameSite=lax`; pending sessions authenticate nothing; session cookie is only sent with `credentials: "include"` and the API allows only the configured browser origins.

**Error and loading states:** Errors in a red paragraph; 429 `too_many_attempts` on verify sends you back to step 1 with the message; 429 `rate_limited` shows the server message. Buttons show "Signing in..." / "Verifying...".

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/dashboard-login/LoginPage.tsx`, `apps/web/src/api/dashboardAuth.ts`, `apps/web/src/auth/DashboardAuthContext.tsx`, `apps/api/src/routes/auth.ts`, `apps/api/src/auth/otp.ts`, `apps/api/src/auth/sessions.ts`, `apps/api/src/auth/passwords.ts`

---

### Page: Merchant registration

**URL:** `/dashboard/register`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Create a new merchant business and its owner user.

**Who can access it:** Anyone (public sign-up). If already signed in, redirects to `/dashboard/onboarding`.

**What the user sees:** "Create your merchant account" with a form: Legal business name, Business registration number, Business type (Limited liability company, Sole proprietorship, Partnership, Public company, Other), Work email, Contact phone, Business address, City, Password, Confirm password, **Create account** button, and a "Sign in" link.

**What the user can do (every button/form/filter):** Fill the fields and submit. The same email is used as the business contact email and the owner's login.

**Step-by-step example:** Enter "Dana Bakery LLC", reg. no. "CR-123", type LLC, `dana@bakery.bh`, phone, address, city, a 12+ character password twice, click Create account. You land on the login page with a "registered" banner.

**What happens in the backend:** `POST /v1/merchants` (`routes/businessProfile.ts`, `onboarding/signup.ts`):
- Checks required fields, business type in the allowed list, email format for both emails, password at least 12 characters, optional 2-letter country code.
- In one transaction: inserts `merchants` (display name = legal name; defaults: `onboarding_status = 'submitted'`, `kyc_passed = false`, `mdr_bps = 250`), `merchant_business_profiles` (country defaults to `BH`), and `merchant_users` (role `owner`, argon2id hash).
- Does not log you in.
- Duplicate email within the same merchant gives 409 `email_already_registered` (but emails are only unique per merchant, so the same email can register a second business).

**Database interaction:** Write `merchants`, `merchant_business_profiles`, `merchant_users`.

**Navigation:** On success to `/dashboard/login` with state `{registered, email, from: "/dashboard/onboarding"}`. Link to login.

**Validation and security:** Page checks password length (12) and that both password fields match before calling the API; API re-validates everything. Public endpoint, now limited to 10 signups per hour per IP (`rate_limited`). The new merchant cannot take payments until KYC approval.

**Error and loading states:** Red error paragraph; button shows "Creating account...".

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/dashboard-login/RegisterPage.tsx`, `apps/web/src/api/onboarding.ts`, `apps/api/src/routes/businessProfile.ts`, `apps/api/src/onboarding/signup.ts`

---

### Page: Dashboard shell (top bar used by every dashboard page)

**URL:** wraps all `/dashboard/*` pages except login and register. `/dashboard` itself redirects to `/dashboard/transactions`.

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** The common header: brand, navigation, who you are, log out.

**Who can access it:** Signed-in merchant users. While the session check is pending it shows "Checking your session..."; if the check fails you are sent to `/dashboard/login` (remembering where you wanted to go).

**What the user sees:** Navigation links: Business verification, Transactions, Payment links, Webhooks (owner/finance only), Settlement, Reconciliation (owner/finance only), Overview. On the right: your email, a role chip (owner / finance / support), the business name, and a **Log out** button.

**What the user can do (every button/form/filter):** Navigate; **Log out**.

**Step-by-step example:** Click Log out: page calls `POST /v1/auth/logout`, clears local state, goes to login.

**What happens in the backend:** `GET /v1/auth/me` (runs once on load and after login/onboarding) returns user, role, merchant id, display name and onboarding status. `POST /v1/auth/logout` revokes the `sessions` row, clears the cookie, returns 204.

**Database interaction:** Read `merchant_users`, `merchants`, `sessions`. Write `sessions` (logout).

**Navigation:** All dashboard sections.

**Validation and security:** Both endpoints use `requireSession`, which accepts only the real merchant session cookie. Important consequence: the admin "View as merchant" impersonation cookie is NOT accepted by `/v1/auth/me`, so an impersonating admin is shown the login page (see the admin merchant detail page).

**Error and loading states:** "Checking your session..." while loading; logout error shown in red.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/components/DashboardLayout.tsx`, `apps/web/src/auth/RequireDashboardAuth.tsx`, `apps/web/src/auth/DashboardAuthContext.tsx`, `apps/web/src/auth/RequireRole.tsx`, `apps/api/src/routes/auth.ts`, `apps/api/src/auth/middleware.ts`

---

### Page: Business verification (onboarding / KYC upload)

**URL:** `/dashboard/onboarding`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Show the merchant's business details and verification status, and let them upload KYC (know-your-customer) documents so FilsPay staff can approve them.

**Who can access it:** Any signed-in merchant user can view; only `owner` and `finance` see the upload form (and the API enforces it).

**What the user sees:** "Business verification", "Status: submitted | under_review | approved | rejected". If approved: a notice with a link to create a payment link; otherwise a hint that payments become available after approval. Business details (legal name, registration number, address, contact). A list of uploaded documents with a **View** link each. For owner/finance: an upload form.

**What the user can do (every button/form/filter):**
- Choose **Document type**: Commercial registration (PDF), Owner ID, Proof of address, Bank letter.
- Choose a **File** (the file picker restricts types: PDF only for commercial registration, PDF/JPEG/PNG otherwise).
- **Upload document** button.
- **View** link per document (opens the file from the API in a new tab).

**Step-by-step example:** Pick "Commercial registration", choose `cr.pdf`, click Upload. Page posts multipart form data, then reloads the profile, documents and the `/me` status. Status changes from `submitted` to `under_review`.

**What happens in the backend:** (`routes/kyc.ts`, `routes/businessProfile.ts`, `onboarding/kyc.ts`)
- `GET /v1/merchants/:merchantId/business-profile` (any role, own merchant only).
- `GET /v1/merchants/:merchantId/kyc/documents` (any role, own merchant only).
- `POST /v1/merchants/:merchantId/kyc/documents` (owner/finance): reads the multipart upload, validates `documentType`, checks the file's real content (magic bytes, not the filename or declared type), requires PDF for commercial registration and bank letter (422 `document_must_be_pdf`), stores the file on disk under the KYC upload folder named by its SHA-256, inserts a `kyc_documents` row (the displayed file name is sanitised: path parts, control characters, quotes, backslashes and semicolons are removed), and if the merchant status was `submitted` or `rejected` sets it to `under_review` (never touches `kyc_passed`). A thumbnail may be generated.
- `GET .../kyc/documents/:documentId/file` (owner/finance) streams the file with `X-Content-Type-Options: nosniff`. The multipart parser accepts 1 file and 10 fields per request.

**Database interaction:** Read `merchant_business_profiles`, `kyc_documents`, `merchants`. Write `kyc_documents`, `merchants.onboarding_status`.

**Navigation:** Link to `/dashboard/payment-links/new` once approved.

**Validation and security:** `assertOwnMerchant` rejects a merchant id that is not the signed-in user's (403). File type is judged from bytes. The upload uses `fetch` directly (not the shared helper) so errors come back as a plain message.

**Error and loading states:** Red error paragraph; green notice after upload; button "Uploading...". A support user sees no upload form, and (fixed in the audit) no longer sees an error banner caused by the document list being owner/finance only; the file-view link would still 403 for them.

**Current implementation status:** Working (code-read, not run). Note: the final approval is done by an admin on the admin console, not here. One locked test about a non-PDF filename (`app.test.ts:274`) still fails and needs a human decision. The route-level changes (nosniff, 1-file limit) are not covered end to end by tests.

**Relevant source files:** `apps/web/src/pages/onboarding/OnboardingPage.tsx`, `apps/web/src/api/onboarding.ts`, `apps/api/src/routes/kyc.ts`, `apps/api/src/routes/businessProfile.ts`, `apps/api/src/onboarding/kyc.ts`, `apps/api/src/onboarding/fileSignature.ts`

---

### Page: Transactions list

**URL:** `/dashboard/transactions` (default landing page after login)

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Browse and search the merchant's payments.

**Who can access it:** Any signed-in merchant user (all roles).

**What the user sees:** "Transactions"; Status checkboxes; From / To (exclusive) / Search filters; "N transactions loaded"; a table with Occurred (a link to the detail page), Reference, Status (colored chip), Authorized amount, Captured amount, Acquirer reference (shortened); "Load more" at the bottom.

**What the user can do (every button/form/filter):**
- Tick statuses: authorized, captured, partially_captured, voided, partially_refunded, refunded, chargeback.
- From / To dates (the page now turns each date into the start of that day in **Asia/Bahrain** time using `bahrainDayStartIso`, so the filter lines up with settlement batches; before the audit it used UTC midnight).
- Search box (debounced 300 ms): matches reference, acquirer reference, or transaction id.
- Click a date to open the detail page; **Load more** for the next 25.

**Step-by-step example:** Tick "captured", set From to today. The page calls `GET /v1/transactions?status=captured&from=2026-10-29T21:00:00.000Z&limit=25` (Bahrain midnight written in UTC).

**What happens in the backend:** `GET /v1/transactions` (`routes/transactions.ts`, `transactions/query.ts`) uses `requireMerchantAuth` (session cookie, or API key, or admin-impersonation cookie for reads). It filters `transactions` by the caller's merchant id (taken from the session, never from the URL), status list, `occurred_at >= from`, `occurred_at < to`, and a case-insensitive `ILIKE` on reference / acquirer reference / id text, ordered newest first with keyset pagination. A malformed `limit`, date or cursor now returns 400 instead of 500 (a tampered cursor used to restart at page 1).

**Database interaction:** Read `transactions`.

**Navigation:** To `/dashboard/transactions/:id`.

**Validation and security:** Merchant scope comes from the session. The search uses `ILIKE '%x%'`, which cannot use an index (a code comment records a latency regression). There is a CSV export endpoint `GET /v1/transactions/export` (31-day maximum window) but no button on this page uses it.

**Error and loading states:** Standard (see 0.5). Note: the filter values "refunded" and "partially_refunded" exist, but nothing in the running API can produce those statuses today (refunds are not routed).

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/transactions/TransactionListPage.tsx`, `apps/web/src/api/transactions.ts`, `apps/web/src/components/Pagination.tsx`, `apps/api/src/routes/transactions.ts`, `apps/api/src/transactions/query.ts`

---

### Page: Transaction detail (with capture, void, and the parked RefundDrawer)

**URL:** `/dashboard/transactions/:id`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Inspect one payment, see its event timeline, and (for owner/finance) capture or void it.

**Who can access it:** Any signed-in merchant user can view. Capture/void buttons are shown only to owner and finance, and the API now enforces the same: a `support` session gets 403 on capture and void. API keys still pass every role check (open finding S-8).

**What the user sees:** Transaction id; Status; Authorized amount; Captured amount; Currency; Reference; Acquirer reference; Occurred at; Created at. An **Event timeline** table (Occurred, Event, Amount, Actor type and id). "Back to transactions". If the id is not yours: "Transaction not found".

**What the user can do (every button/form/filter):**
- **Capture** (shown when status is `authorized` or `partially_captured`): opens a small form "Amount in fils (blank captures everything outstanding)" with **Capture** and **Cancel**. The amount is entered in fils, not BD, and the page rejects anything that is not a whole number of fils.
- **Void** (only when status is `authorized`): confirm dialog, then voids.
- **Refund: not available.** `RefundDrawer.tsx` exists but its entire body is commented out and nothing imports it (the file header says it is parked until the refund API exists).

**The RefundDrawer component (parked, not on screen):** If it were enabled it would show a **Refund** button (owner/finance, status captured or partially captured), a form "Amount in fils (blank refunds everything still refundable)", a confirm dialog, and POST to `/v1/merchants/<merchantId>/refunds` with a fresh idempotency key. That route does not exist on the API. The only refund route is `POST /v1/refunds`, which answers 501. So even if the drawer were switched on today, the refund could not complete.

**Step-by-step example (capture):**
1. Open an `authorized` transaction of 20.000 BHD.
2. Click Capture, type `5000`, click Capture. The page calls `POST /v1/transactions/:id/capture` with body `{"amountFils":5000}` and a new `Idempotency-Key`.
3. Status becomes `partially_captured`, captured shows 5.000 BHD; timeline gains a `partially_captured` event.
4. Capture again with the box blank to capture the remaining 15.000 BHD; status becomes `captured`.

**What happens in the backend:**
- `GET /v1/transactions/:id` and `GET /v1/transactions/:id/events`: merchant-scoped lookups (404 `transaction_not_found` if it is not this merchant's); events come from `transaction_events` oldest first.
- `POST /v1/transactions/:id/capture` (`payments/capture.ts`): needs `Idempotency-Key` (400 otherwise). Locks the transaction row. Not authorized/partially captured gives 409 `not_capturable`. Amount `<= 0` or more than remaining gives 422 `capture_exceeds_remaining`. Calls the simulated acquirer (decline 402 `card_captured_declined`, error 502 `acquirer_unavailable`). On approval: fee = amount x (effective MDR bps minus platform volume-tier bonus bps), computed in integers; updates `transactions` (status, `captured_fils`); inserts balanced `ledger_entries` (gross and fee pairs); releases the `holds` row when fully captured; inserts `outbox_events` (`transaction.captured`) and `transaction_events` (`captured` or `partially_captured`, with fee metadata). After a 200, `applyCaptureDiscountAdjustment` runs in a separate transaction.
- `POST /v1/transactions/:id/void` (`payments/void.ts`): locks the row; if already `voided` returns 200 with the same row (idempotent, no new event); if not `authorized` returns 409 `not_voidable`; otherwise sets `voided`, releases the hold, inserts `transaction_events` (`voided`) and `outbox_events` (`transaction.voided`). No acquirer call.

**Database interaction:** Read `transactions`, `transaction_events`, `merchants`, `fee_schedules`, `platform_stats`. Write `transactions`, `holds`, `ledger_entries`, `transaction_events`, `outbox_events`, `idempotency_keys`, `merchant_daily_volume`.

**Navigation:** Back to the list. (Settlement and payment-link pages link here.)

**Validation and security:** Capture and void now require merchant role `owner` or `finance` for session users (fixed in code, covered by unit tests, not exercised in a live browser). API keys have no role and still pass. A stale comment near the buttons in `TransactionDetailPage.tsx` still says the server does not gate capture and void; the comment is wrong now. An admin impersonating a merchant is refused for writes (`requireMerchantWriterActor`). Capture is protected against double-submit by the idempotency key; the page creates a new key per click. A malformed transaction id returns 400/404, not 500.

**Error and loading states:** "Loading..."; 404 -> "Transaction not found" panel; other load errors in red; action errors (for example 422) shown above the buttons.

**Current implementation status:** Capture and Void: Working (code-read, not run). Refund on this page: **Not Implemented** (button absent; `POST /v1/refunds` returns 501; drawer parked and would target a non-existent route).

**Relevant source files:** `apps/web/src/pages/transactions/TransactionDetailPage.tsx`, `apps/web/src/pages/transactions/RefundDrawer.tsx`, `apps/web/src/api/transactions.ts`, `apps/api/src/routes/transactions.ts`, `apps/api/src/payments/capture.ts`, `apps/api/src/payments/void.ts`, `apps/api/src/routes/refunds.ts`, `apps/api/src/refunds/initiateMerchantRefund.ts`, `apps/api/src/payments/processRefund.ts`

---

### Page: Payment links list

**URL:** `/dashboard/payment-links`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** See all the pay-by-link requests the merchant created.

**Who can access it:** Any signed-in merchant user.

**What the user sees:** A **New payment link** button (owner/finance only), status checkboxes (active, reserved, paid, canceled), a table: Reference (link to detail), Description, Amount, Status, Expires, Paid, Canceled; "Load more".

**What the user can do (every button/form/filter):** Tick statuses; click a reference to open its detail; New payment link; Load more.

**Step-by-step example:** Tick "paid" to see only paid links; the page calls `GET /v1/merchants/<merchantId>/payment-links?status=paid&limit=25`.

**What happens in the backend:** `GET /v1/merchants/:merchantId/payment-links` (`routes/paymentLinks.ts`, `paymentLinks/query.ts`): `requireMerchantAuth`; `assertOwnMerchant`; reads `payment_links` newest first, limit default 25, max 100, cursor on `(created_at, id)`. Each row includes the shareable `url` built from `CHECKOUT_BASE_URL` (default `http://localhost:5173`).

**Database interaction:** Read `payment_links`.

**Navigation:** To `/dashboard/payment-links/new` and `/dashboard/payment-links/:id`.

**Validation and security:** Merchant id in the URL must equal the session's merchant (403 `forbidden` otherwise).

**Error and loading states:** Standard.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/payment-links/PaymentLinkListPage.tsx`, `apps/web/src/api/paymentLinks.ts`, `apps/api/src/routes/paymentLinks.ts`, `apps/api/src/paymentLinks/query.ts`, `apps/api/src/paymentLinks/serialize.ts`

---

### Page: New payment link

**URL:** `/dashboard/payment-links/new`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Create a payment link to send to a customer.

**Who can access it:** `owner` and `finance`. A `support` user sees "You don't have permission to use this page" (`RoleGatedPage`). The API also enforces it (403).

**What the user sees:** "New payment link" with Amount (BHD), Reference (optional), Description (optional), Expires at (date and time), and **Create payment link**.

**What the user can do (every button/form/filter):** Fill the form and submit; "Back to payment links".

**Step-by-step example:** Amount `12.500`, reference `INV-77`, expiry tomorrow 18:00. The page converts `12.500` to `12500` fils with `parseBhdToFils`, then posts `{amountFils:12500, reference, expiresAt:"<ISO>"}`. You are taken to the new link's detail page, where you can copy the URL.

**What happens in the backend:** `POST /v1/merchants/:merchantId/payment-links` (owner/finance): both `amountFils` and `expiresAt` required (400 `invalid_request`); `toFils` rejects non-integer, zero or negative amounts (400 `invalid_amount`); `expiresAt` must be a valid future date (400 `invalid_expiry`). Inserts a `payment_links` row with token `plink_` + 22 random characters (from `lib/random.ts`), status `active`, and who created it. Returns 201 with the link including its `url`.

**Database interaction:** Write `payment_links`.

**Navigation:** On success to `/dashboard/payment-links/:id` (replace). Back link to the list.

**Validation and security:** Page checks: valid BHD with at most 3 decimals, amount above zero, expiry valid and in the future. Server repeats the checks. The token comes from `randomFromAlphabet` in `lib/random.ts`, which uses Node's `crypto.randomInt` (a cryptographically secure generator; before the audit it was `Math.random`), so the link cannot be guessed. The token is the only protection of the public checkout page. Amount upper bounds for payment links are not enforced (open).

**Error and loading states:** Red error paragraph; button "Creating...".

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/payment-links/PaymentLinkCreatePage.tsx`, `apps/web/src/format.ts`, `apps/web/src/auth/RequireRole.tsx`, `apps/api/src/routes/paymentLinks.ts`, `apps/api/src/paymentLinks/create.ts`, `apps/api/src/lib/random.ts`

---

### Page: Payment link detail

**URL:** `/dashboard/payment-links/:id`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** See one link, copy its checkout URL, see whether it was paid, and cancel it.

**Who can access it:** Any signed-in merchant user. The Cancel button is for owner/finance only.

**What the user sees:** Id, Amount, Currency, Status, Reference, Description, Expires at, Created at, Paid at, Canceled at, Transaction (link to the transaction page once paid), Checkout link (clickable URL plus **Copy link**), and **Cancel payment link** when status is `active`.

**What the user can do (every button/form/filter):** Open the checkout URL in a new tab; **Copy link**; **Cancel payment link** (confirm dialog).

**Step-by-step example:** Click Cancel, confirm. Page calls `DELETE /v1/merchants/<merchantId>/payment-links/<id>` (204), reloads, status shows `canceled`.

**What happens in the backend:**
- There is no "get one payment link" endpoint for merchants. The page calls the list endpoint with `limit=100` and finds the id in the results. A link older than the merchant's 100 most recent shows "not among your 100 most recent payment links".
- `DELETE /v1/merchants/:merchantId/payment-links/:id` (owner/finance): `cancelPaymentLink` sets `status = 'canceled'`, `canceled_at` for the merchant's own `active` link. Not found gives 404 `payment_link_not_found`; a paid, already canceled or `reserved` link gives 409 `not_cancelable`.

**Database interaction:** Read and write `payment_links`.

**Navigation:** To the transaction detail, the public checkout URL, back to the list.

**Validation and security:** Merchant scope enforced in the path and in the SQL (`merchant_id = $2`).

**Error and loading states:** "Loading..."; "Payment link not found" panel; errors in red.

**Current implementation status:** Partially Working (code-read, not run): works for the 100 most recent links; older links cannot be opened here because no single-link endpoint exists.

**Relevant source files:** `apps/web/src/pages/payment-links/PaymentLinkDetailPage.tsx`, `apps/api/src/routes/paymentLinks.ts`, `apps/api/src/paymentLinks/cancel.ts`, `apps/api/src/paymentLinks/query.ts`

---

### Page: Settlement batches list

**URL:** `/dashboard/settlement`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Show the merchant's daily settlement batches (the daily bundles of captured money that get paid out).

**Who can access it:** Any signed-in merchant user.

**What the user sees:** Filters Batch date From / To (exclusive) and Status (open, closed, paid); a table: Batch date (link), Status, Gross, Fee, Net payout, Closed, Paid; "Load more".

**What the user can do (every button/form/filter):** Filter by date or status; open a batch; load more. Nothing here changes data.

**Step-by-step example:** Tick "paid" and see which days have been paid out. Gross minus Fee equals Net payout.

**What happens in the backend:** `GET /v1/settlement/batches` (`routes/settlement.ts`, `settlement/query.ts`): reads `settlement_batches` for the caller's merchant, optional date range on `batch_date`, status list, keyset pagination. Batches are created by the Go settlement service, never by this API (the API's own comment: "nothing here triggers, re-runs, or mutates a batch").

**Database interaction:** Read `settlement_batches`.

**Navigation:** To `/dashboard/settlement/:id`.

**Validation and security:** `requireMerchantAuth`, scoped by the session's merchant.

**Error and loading states:** Standard.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/settlement/SettlementBatchListPage.tsx`, `apps/web/src/api/settlement.ts`, `apps/api/src/routes/settlement.ts`, `apps/api/src/settlement/query.ts`

---

### Page: Settlement batch detail

**URL:** `/dashboard/settlement/:id`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Drill into one batch: totals and the transactions (scheme export lines) it contains.

**Who can access it:** Any signed-in merchant user.

**What the user sees:** "Settlement batch <date>"; Status, Gross, Fee, Net payout, Closed at, Paid at, Included transactions, Capture events in this batch; a table: Line, Transaction (link), Reference, Status, Authorized, Captured, Scheme amount; a note that the scheme amount is quantized to two decimals (up to 9 fils below the captured amount by design).

**What the user can do (every button/form/filter):** Click a transaction; back to the list. Read only.

**Step-by-step example:** From the list, click a date. The page calls `GET /v1/settlement/batches/:id` and `GET /v1/settlement/batches/:id/transactions` in parallel.

**What happens in the backend:** Both routes first verify the batch belongs to the caller's merchant (404 `settlement_batch_not_found`). Detail adds counts from `scheme_export_lines` and `transaction_events`. Transactions come from `scheme_export_lines` joined to `transactions`.

**Database interaction:** Read `settlement_batches`, `scheme_export_lines`, `transaction_events`, `transactions`.

**Navigation:** To transactions, back to list.

**Validation and security:** Merchant scope enforced in the query.

**Error and loading states:** "Loading..."; "Settlement batch not found"; errors in red.

**Current implementation status:** Working (code-read, not run). The meaningless "progress bar" that used float math on `grossFils` was removed in the audit.

**Relevant source files:** `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx`, `apps/api/src/routes/settlement.ts`, `apps/api/src/settlement/query.ts`

---

### Page: Reconciliation

**URL:** `/dashboard/reconciliation`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Check that the ledger (the accounting record) and settlement agree for a date range, and show any gap honestly.

**Who can access it:** `owner` and `finance` only. The nav link is hidden for `support`, and the API answers 403, which the page turns into a friendly "You don't have permission" message. (Unlike transaction capture, this page's role limit is enforced server side.)

**What the user sees:** From / To (exclusive) dates defaulting to the last 30 Asia/Bahrain days; **Run report**; a badge "Reconciled - no gap" or "Gap: X BHD"; Period; Ledger merchant payable (net); Settlement net payout; Pending, not yet batched; Gap; an explanation "Gap = ledger merchant payable - settlement net payout - pending unbatched."

**What the user can do (every button/form/filter):** Change dates and click Run report.

**Step-by-step example:** Keep the default range and click Run report; the page calls `GET /v1/settlement/reconciliation?from=2026-09-30&to=2026-10-31`.

**What happens in the backend:** `GET /v1/settlement/reconciliation` (`requireMerchantAuth` + `requireMerchantRole('owner','finance')`; both dates required, 400 `invalid_request`). `getReconciliationReport` sums `ledger_entries` for account `merchant_payable`, sums `settlement_batches` for the date range, and computes pending, not-yet-batched captured amounts from `transaction_events` and `ledger_entries`.

**Database interaction:** Read `ledger_entries`, `settlement_batches`, `transaction_events`, `transactions`.

**Navigation:** None.

**Validation and security:** Role-gated server side. Dates are Bahrain business dates.

**Error and loading states:** 403 -> permission message; other errors in red; "Loading...".

**Current implementation status:** Not Verified (code-read, not run). The page and endpoint are wired consistently, but whether the numbers always reconcile was not tested; code comments in `api/settlement.ts` show two engineers disagreeing about whether the gap is "always 0" for merchants with negotiated discounts, and the Go ledger package has known failing tests at baseline.

**Relevant source files:** `apps/web/src/pages/settlement/ReconciliationPage.tsx`, `apps/web/src/api/settlement.ts`, `apps/api/src/routes/settlement.ts`, `apps/api/src/settlement/query.ts`

---

### Page: Webhook endpoints list

**URL:** `/dashboard/webhooks`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Manage the URLs on the merchant's own server that FilsPay calls when something happens.

**Who can access it:** `owner` and `finance` (route is wrapped in `RoleGatedPage`; the whole webhook API is owner/finance only, including the list). `support` users do not see the nav link and see a permission message if they type the URL.

**What the user sees:** "Webhook endpoints", **New endpoint** button, a table: URL (link to detail), Secret prefix, Status (active/disabled), Created, Actions (**Disable**/**Enable**, **Delete**).

**What the user can do (every button/form/filter):**
- **New endpoint** -> create page.
- **Disable / Enable:** toggles the endpoint's status (`PATCH`).
- **Delete:** confirm dialog, then `DELETE`. The dialog says it "cannot be undone"; in the code it is a soft delete (the row is kept with `deleted_at` set and status `disabled`, and the delivery history is kept). A deleted endpoint now returns 404 on test-send and detail.

**Step-by-step example:** Click Disable on an endpoint: `PATCH /v1/merchants/<id>/webhook-endpoints/<endpointId>` with `{"status":"disabled"}`; the list reloads.

**What happens in the backend:** `GET /v1/merchants/:merchantId/webhook-endpoints` (reads `webhook_endpoints` where `deleted_at IS NULL`); `PATCH` (`webhooks/update.ts`, may also change the URL; URL rules as in the create page); `DELETE` (`webhooks/cancel.ts`: `UPDATE webhook_endpoints SET status='disabled', deleted_at=now()`). All require `requireMerchantAuth` + `requireMerchantRole('owner','finance')`.

**Database interaction:** Read and write `webhook_endpoints`.

**Navigation:** To `/dashboard/webhooks/new`, `/dashboard/webhooks/:id`.

**Validation and security:** Role checks both sides; merchant id must match session.

**Error and loading states:** Standard; "No webhook endpoints registered."

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/webhooks/WebhookEndpointListPage.tsx`, `apps/web/src/api/webhooks.ts`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/webhooks/list.ts`, `apps/api/src/webhooks/update.ts`, `apps/api/src/webhooks/cancel.ts`

---

### Page: New webhook endpoint

**URL:** `/dashboard/webhooks/new`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Register a new webhook URL and obtain its signing secret.

**Who can access it:** `owner` and `finance`.

**What the user sees:** A form "Endpoint URL" and **Create endpoint**. After creation: "Endpoint created" with a highlighted "Signing secret - shown once" box (the secret and a **Copy secret** button), the URL, secret prefix, status, created time, and **I've saved it - continue**.

**What the user can do (every button/form/filter):** Enter a URL, create, copy the secret, continue to the detail page.

**Step-by-step example:** Enter `https://shop.example.com/filspay/webhooks`, click Create endpoint. Copy the secret now; it is never shown again.

**What happens in the backend:** `POST /v1/merchants/:merchantId/webhook-endpoints` (`webhooks/create.ts`): URL must parse and be http or https; in production it must be https and must not point at a private/internal host, and the host name is resolved and every answer is checked against a wider private-range blocklist (400 `invalid_url`). At send time the connection is pinned to the vetted IPs (stops DNS rebinding). These guards run only when `NODE_ENV=production`; an unset `NODE_ENV` means development and switches them off (open decision S-19). Fixed in code, covered by unit tests; not exercised against real public DNS. A random secret is generated, stored **encrypted** (`secret_ciphertext`, key from `WEBHOOK_SECRET_ENCRYPTION_KEY`) because every delivery needs it to compute the signature, and only a prefix is stored for display. Returns 201 including the plaintext `secret` once.

**Database interaction:** Write `webhook_endpoints`.

**Navigation:** Continue to `/dashboard/webhooks/:id`; back to the list.

**Validation and security:** `type="url"` in the browser; server validates again. Secret never returned again.

**Error and loading states:** Red error; "Creating...".

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/webhooks/WebhookEndpointCreatePage.tsx`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/webhooks/create.ts`, `apps/api/src/webhooks/secretCrypto.ts`

---

### Page: Webhook endpoint detail (delivery log, replay, test event)

**URL:** `/dashboard/webhooks/:id`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** See one endpoint and every delivery attempt FilsPay made to it; replay a delivery; send a test event.

**Who can access it:** `owner` and `finance` through the dashboard route gate. (The deliveries list API also allows `support`, but the page itself is gated.)

**What the user sees:** URL, Secret prefix, Status, Created at, Updated at. For active endpoints, **Send test event**. A **Delivery log** with status checkboxes (pending, succeeded, failed, exhausted) and a table: Created, Event, Status, Attempts, Response (status code plus expandable body), Last attempt, Next attempt, Replay of, Actions.

**What the user can do (every button/form/filter):**
- **Send test event:** posts a signed `test.ping` event right now and shows "Receiver responded with HTTP N." or "The receiver could not be reached." plus the body excerpt.
- Status filters; **Load more**.
- **Replay** (shown for `succeeded` or `exhausted` deliveries on an active endpoint): queues a new delivery with the same payload.

**Step-by-step example:** A delivery is `exhausted` (eight failed attempts). Fix your server, click Replay. The API answers 202 `{deliveryId, status:"pending"}`; a new row appears in the log, linked "replay of <original id>", and is sent by the background dispatcher on its next pass.

**What happens in the backend:**
- The page finds its endpoint by loading the full endpoint list and picking the id (no get-one endpoint).
- `GET .../deliveries` (owner/finance/support) reads `webhook_deliveries` with keyset pagination.
- `POST .../deliveries/:deliveryId/replay` (`webhooks/replay.ts`): original delivery must belong to this endpoint and merchant (404 `webhook_delivery_not_found`); endpoint must be active (409 `endpoint_disabled`); inserts a new `webhook_deliveries` row (`pending`, `next_attempt_at = now()`, `replay_of_delivery_id` set) with a **new** `delivery_event_id` copied into the payload `id`. (`docs/ADMIN.md:89`, which says the same id is reused, is wrong.)
- `POST .../test` (`webhooks/testSend.ts`): signs and sends a `test.ping` event synchronously through the webhook transport and returns the receiver's response (404 if the endpoint was deleted); it does not write to the delivery log.
- How deliveries are actually sent and retried is explained in the "Webhook delivery and retry" flow in `COMPLETE_USER_FLOWS.md`.

**Database interaction:** Read `webhook_endpoints`, `webhook_deliveries`. Write `webhook_deliveries` (replay).

**Navigation:** Back to the list.

**Validation and security:** Role gate both sides; merchant scope enforced; deliveries carry an HMAC signature header `Webhook-Signature: t=<unix seconds>,v1=<hex>` and `Webhook-Delivery-Id`.

**Error and loading states:** "Endpoint not found" panel; standard errors. The status filter offers `failed`, but the dispatcher never sets that status (only `pending`, `succeeded`, `exhausted`), so that filter always returns nothing in practice.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx`, `apps/web/src/api/webhooks.ts`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/webhooks/deliveries.ts`, `apps/api/src/webhooks/replay.ts`, `apps/api/src/webhooks/testSend.ts`, `apps/api/src/webhooks/dispatcher.ts`

---

### Page: Overview (analytics)

**URL:** `/dashboard/overview`

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** At-a-glance reporting: captured volume per day, payout trends, top paid payment links.

**Who can access it:** Any signed-in merchant user.

**What the user sees:** Filters (From, To exclusive, Top links 1 to 50) and **Refresh**; three tables, each with a freshness badge (`StalenessBadge`: shows how old the read model is, or that the data is live): Captured volume (Date, Captured count, Gross, Voided, bar); Payout trends (Batch date link, Status, Gross, Fee, Net payout, Paid); Top paid links (rank, Reference link, Description, Amount, Paid at).

**What the user can do (every button/form/filter):** Set dates (blank = last 30 Bahrain days), set top-links count, **Refresh**. The page also refreshes itself every 60 seconds.

**Step-by-step example:** Leave defaults; the page calls three endpoints in parallel: `GET /v1/analytics/volumes`, `/payout-trends`, `/top-links?limit=10`.

**What happens in the backend:** (`routes/analytics.ts`, `analytics/query.ts`) `requireMerchantAuth` (any role). Dates must be `YYYY-MM-DD` (400 `invalid_date`); defaults are today (Bahrain) minus 30 days to tomorrow. Volumes and payout trends read the pre-built tables `merchant_daily_volume` and `merchant_payout_trends`, which the reporting worker (`apps/reporting`) fills by consuming `outbox_events` (`transaction.captured`, `transaction.voided`, `settlement.batch_closed`, `settlement.paid`); the response includes `readModelAsOf` and `live` so the page can show staleness. Top links read `payment_links` directly, ordered by amount, using Bahrain-midnight bounds on `paid_at`. (An extra `recent-ledger-activity` endpoint exists but no page uses it.)

**Database interaction:** Read `merchant_daily_volume`, `merchant_payout_trends`, `reporting_outbox_cursor`, `payment_links`, `ledger_entries`.

**Navigation:** Links to settlement batch detail and payment link detail.

**Validation and security:** Merchant scope from session.

**Error and loading states:** Standard; "Refreshing..." on the button.

**Current implementation status:** Working (code-read, not run) as long as the reporting worker is running; if it is not, numbers lag and the badge says so. Admins can force a rebuild from Settlement ops. The `/v1/reporting/*` endpoints (filtered transactions report, saved filters, export summary) have no page.

**Relevant source files:** `apps/web/src/pages/overview/OverviewPage.tsx`, `apps/web/src/api/analytics.ts`, `apps/web/src/components/StalenessBadge.tsx`, `apps/api/src/routes/analytics.ts`, `apps/api/src/analytics/query.ts`, `apps/reporting/src/consumer/applyEvent.ts`

---

### Page: Dashboard "page not found" and error screens

**URL:** any unknown address (router path `*`), and any route that throws while rendering.

**Application:** Merchant dashboard (`apps/web`)

**Purpose:** Catch bad URLs and crashes with a readable page instead of a blank screen.

**Who can access it:** Anyone.

**What the user sees:** `RouteNotFound`: "Page not found / The address may be incorrect or the page may have moved." `RouteErrorBoundary`: "This page could not be loaded" plus the error message. Both have a "Return to FilsPay" link to `/`.

**What the user can do (every button/form/filter):** Click the return link.

**Step-by-step example:** Visit `/dashboard/nope`. Because it is not in the table, the `*` route shows "Page not found".

**What happens in the backend:** Nothing.

**Database interaction:** None.

**Navigation:** Link to `/` which redirects to the login page.

**Validation and security:** None. The error boundary is attached to `/pay/:token` and to the dashboard route group.

**Error and loading states:** This is the error state.

**Current implementation status:** Working (code-read, not run). The unknown address `/dashboard/refunds` also lands here (the router comment says the refunds route was removed until FP-212).

**Relevant source files:** `apps/web/src/components/RouteFallback.tsx`, `apps/web/src/router.tsx`

---

# PART B: Admin console (`apps/admin`, port 5174)

Route table is `apps/admin/src/router.tsx`:

```
/login                      -> LoginPage
<RequireAdminAuth>          -> redirect to /login when not signed in
  <AdminLayout>             -> nav + (ImpersonationBanner)
    /                       -> redirect to /merchants
    /merchants, /merchants/:id
    /credits
    /settlement
    /adjustment-imports
    /webhooks, /webhooks/:merchantId
*                           -> RouteNotFound
```

All admin API calls use `apps/admin/src/api/client.ts` (base `http://localhost:3000`, cookie `fp_admin_sid`). The server-side admin routes are mounted under `/v1/admin` in `apps/api/src/routes/admin.ts`. Admin roles: `support` (read-only plus a few routine actions), `finance`, `super_admin` (finance and super_admin can do money-moving actions).

Every sensitive admin action writes a row to `admin_audit_log`.

---

### Page: Admin sign-in

**URL:** `/login` (admin app)

**Application:** Admin console (`apps/admin`)

**Purpose:** Staff sign-in with email, password and OTP.

**Who can access it:** Anyone can see it; only staff with an active `admin_users` row can get in. If already signed in, redirects to `/merchants` (or where you were headed).

**What the user sees:** "FilsPay Admin / Internal operations console." Step 1: Email, Password, **Continue**. Step 2: "A one-time code was issued for <email>. It expires at <time>", a dev code line in development, One-time code field, **Verify**, **Start over**.

**What the user can do (every button/form/filter):** Continue; Verify; Start over. There is no "Resend code" button and no resend endpoint on the admin side.

**Step-by-step example:** Enter email and password -> `POST /v1/admin/auth/login`; enter the code -> `POST /v1/admin/auth/otp/verify`; page refreshes `GET /v1/admin/auth/me`, then goes to `/merchants`.

**What happens in the backend:** (`routes/adminAuth.ts`)
- Login: looks up `admin_users` by exact email with status `active`; verifies password (dummy hash if no user, to keep timing similar); generic 401 `invalid_credentials`. Creates `admin_otp_challenges` and a pending `admin_sessions` row; sends the code; sets cookie `fp_admin_sid`. Disabled admins cannot log in, and existing sessions of a disabled admin stop working.
- Verify: same lock-and-check pattern as the merchant flow (410 expired, 429 too many attempts, 401 invalid). On success the session is promoted. The **session token is rotated** (new cookie value) only when `ROTATE_SESSION_ON_OTP_VERIFY` is on (default ON in production, OFF elsewhere; many locked route tests reuse the pre-verify cookie, which is why it is off in development and test). With rotation on, a token that was visible during the OTP step is no longer valid afterwards. Admin login is limited to 10 per minute per IP and email.

**Database interaction:** Read `admin_users`. Write `admin_otp_challenges`, `admin_sessions`.

**Navigation:** To `/merchants` after success.

**Validation and security:** Separate cookie, tables and middleware from merchant auth; admin sessions are never resolvable as merchant authority and vice versa.

**Error and loading states:** Red error; "Signing in..." / "Verifying...".

**Current implementation status:** Working (code-read, not run). The rotation is covered only by `auth/otpSessionRotation.new.test.ts`.

**Relevant source files:** `apps/admin/src/pages/login/LoginPage.tsx`, `apps/admin/src/api/auth.ts`, `apps/admin/src/auth/AdminAuthContext.tsx`, `apps/admin/src/components/RequireAdminAuth.tsx`, `apps/api/src/routes/adminAuth.ts`, `apps/api/src/adminAuth/middleware.ts`, `apps/api/src/adminAuth/sessions.ts`

---

### Page: Admin shell (navigation and impersonation banner)

**URL:** wraps every admin page except `/login`.

**Application:** Admin console (`apps/admin`)

**Purpose:** Common header and the "you are impersonating" banner.

**Who can access it:** Signed-in admins. While the session check runs: "Checking your session...". Anonymous: redirect to `/login`.

**What the user sees:** "FilsPay Admin"; nav links Merchants, Credits, Settlement ops, Import adjustments, Webhook replay; your email and role chip; **Log out**. When an impersonation grant is active: a red banner "You are viewing as a merchant. Active grant for <merchant>, expiring <time>..." with **Exit impersonation**, AND the main area is replaced by "Admin screens are paused" until you exit.

**What the user can do (every button/form/filter):** Navigate; **Log out** (`POST /v1/admin/auth/logout`, clears the local grant record too); **Exit impersonation** (`POST /v1/admin/impersonation/:grantId/end`).

**Step-by-step example:** After "View as merchant", the admin console shows "Admin screens are paused" and points you to the merchant app at `http://localhost:5173`. Click Exit impersonation to resume.

**What happens in the backend:** `GET /v1/admin/auth/me`; `POST /v1/admin/auth/logout` (revokes `admin_sessions` row); `POST /v1/admin/impersonation/:grantId/end` (any admin role; sets `ended_at` on `admin_impersonation_grants` for a grant that belongs to this admin, writes audit row `impersonation_end`, clears the `fp_impersonation` cookie; 404 `impersonation_grant_not_found` otherwise). The grant record in the browser is kept in `localStorage` key `filspay.admin.impersonation` and re-read every 15 seconds so the banner disappears when the grant expires (default 15 minutes). If the end call fails, the banner is no longer cleared (fixed in the audit; unit tests cover only the date helpers, not this behaviour).

**Database interaction:** Read/write `admin_sessions`, `admin_impersonation_grants`, `admin_audit_log`.

**Navigation:** All admin sections.

**Validation and security:** The local record is only a UI hint; the server decides whether a grant is valid.

**Error and loading states:** Errors in red above the content.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/admin/src/components/AdminLayout.tsx`, `apps/admin/src/components/ImpersonationBanner.tsx`, `apps/admin/src/components/RequireAdminAuth.tsx`, `apps/admin/src/auth/AdminAuthContext.tsx`, `apps/admin/src/api/impersonation.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/admin/impersonation.ts`

---

### Page: Admin merchants list

**URL:** `/merchants` (also reached from `/`)

**Application:** Admin console (`apps/admin`)

**Purpose:** Find any merchant on the platform; bulk-approve KYC.

**Who can access it:** Any admin role. The bulk approve button is for finance and super_admin.

**What the user sees:** "Merchants"; a Search box; Onboarding status checkboxes (submitted, under_review, approved, rejected); a table with a select checkbox, Merchant (name link and id), Status, Onboarding, KYC (passed / not passed), MDR (percent, from basis points), Mode (test/live), Created; "Load more".

**What the user can do (every button/form/filter):**
- **Search** by display name, merchant id, or contact email.
- Onboarding status checkboxes.
- Row checkboxes and a select-all-loaded checkbox in the header.
- With a selection: "N selected", **Bulk approve KYC** (finance/super_admin only), **Clear selection**.
- Click a merchant name to open detail; **Load more** (25 per page).

**Step-by-step example:** Tick "under_review", tick two merchants, click Bulk approve KYC. The page calls `POST /v1/admin/merchants/bulk-approve` with their ids and shows "Approved KYC for 2 merchant(s)."

**What happens in the backend:**
- `GET /v1/admin/merchants` (any admin role, `admin/merchants.ts`): the one deliberately cross-merchant query; joins `merchants` with `merchant_business_profiles`, case-insensitive match on name/id/email, status filter, cursor.
- `POST /v1/admin/merchants/bulk-approve` (finance/super_admin; `routes/adminMerchantsBulk.ts`, `admin/bulkKyc.ts`): 1 to 200 UUIDs (400 otherwise). In one transaction locks only merchants whose `onboarding_status = 'under_review'`, and for each inserts a `merchant_kyc_reviews` row (approved) and sets `onboarding_status='approved'`, `kyc_passed=true`; writes an `admin_audit_log` row `kyc_bulk_approve`. Ids that do not exist or are not under review come back in `skippedMerchantIds`.

**Database interaction:** Read `merchants`, `merchant_business_profiles`. Write `merchant_kyc_reviews`, `merchants`, `admin_audit_log`.

**Navigation:** To `/merchants/:id`.

**Validation and security:** Role check server side. Note: bulk approval does not look at the uploaded documents, and has no confirm dialog; the admin must have reviewed them separately. Single approve has no status or document precondition on the server (open decision S-4).

**Error and loading states:** Standard; notice line after a bulk action.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/admin/src/pages/merchants/MerchantListPage.tsx`, `apps/admin/src/api/merchants.ts`, `apps/admin/src/api/merchantsBulk.ts`, `apps/api/src/routes/adminMerchants.ts`, `apps/api/src/routes/adminMerchantsBulk.ts`, `apps/api/src/admin/merchants.ts`, `apps/api/src/admin/bulkKyc.ts`

---

### Page: Admin merchant detail (every button)

**URL:** `/merchants/:id`

**Application:** Admin console (`apps/admin`)

**Purpose:** The single control panel for one merchant: profile, balance, corrections, credits, KYC, API keys, webhooks, settlement history, and impersonation.

**Who can access it:** Any admin role can open it. Most action sections are finance/super_admin; others see a read-only message ("Ask a finance admin").

**What the user sees (sections in order):** Merchant name and id; Profile (status, onboarding, KYC, MDR %, bps, current negotiated rate if any, mode, created, plus business profile fields); Balance (cached payable, with a reminder the ledger is authoritative); Adjust balance; Issue credit; KYC review (documents, notes, buttons, history); API keys; Webhook endpoints; Recent settlement batches; Recompute transaction statuses; View as merchant.

**What the user can do (every button/form/filter), with exactly what each one calls:**

1. **Adjust balance** (finance/super_admin): fields "Delta (fils, may be negative)" and "Reason"; button **Adjust balance** (disabled until both filled). Page demands a non-zero whole number and now rejects text such as `1e3` or `0x10`. Calls `POST /v1/admin/merchants/:id/balance-adjustments` `{deltaFils, reason}`. Result notice shows before and after balance in BHD.
2. **Issue credit** (finance/super_admin): Amount (BD, up to 3 decimals; parsed by `parseBhdToFils`), Reason (Goodwill, Dispute resolution, Correction), Effective date, checkbox "Also reverse the MDR on this amount (x%)", Memo; button **Issue credit**. Calls `POST /v1/admin/merchants/:id/credits`. Notice says either "posted to the ledger (entry group ...)" or "raised and awaiting a second approver - see Credits".
3. **KYC review:** list of **Uploaded documents** with **View document** links (finance/super_admin only), Notes textarea, **Approve KYC**, **Reject KYC** (finance/super_admin). Calls `POST /v1/admin/merchants/:id/kyc-reviews` `{outcome, notes}`. Notice: "KYC approved. Onboarding status is now approved (kycPassed: true)." Below, **Review history** table (Outcome, Reviewer, Notes, Reviewed at).
4. **API keys** table (Prefix, Label, Created, Last used, Revoked) with **Rotate** per active key (finance/super_admin; others see "finance role required"). Rotate opens a confirm panel with an optional new label, **Yes, rotate it**, **Cancel**. Calls `POST /v1/admin/merchants/:id/api-keys/:keyId/rotate`. The new raw key is shown once in a notice with **Dismiss**.
5. **Webhook endpoints** table (URL, Status, Secret prefix, Created), and a link "Replay a batch of deliveries for this merchant" to `/webhooks/:merchantId`.
6. **Recent settlement batches** table (Date, Status, Gross, Fee, Net payout). Read only.
7. **Recompute statuses** (finance/super_admin): button calls `POST /v1/admin/merchants/:id/transactions/recompute-statuses`; notice "Scanned N transactions; M statuses updated."
8. **View as merchant** (all roles, including `support`): calls `POST /v1/admin/merchants/:id/impersonate`, stores the grant locally, opens `http://localhost:5173` in a new tab (or shows a link if the browser blocks the pop-up). See the limitation below.

**Step-by-step example (approve a merchant):** Merchants list -> click "Dana Bakery" -> read documents with View document -> type a note -> click **Approve KYC**. The merchant's status becomes `approved`; they can now authorize payments.

**What happens in the backend:**
- `GET /v1/admin/merchants/:id` (any admin): composes `merchants`, `merchant_business_profiles`, `merchant_kyc_reviews`, `merchant_balances`, `api_keys`, `webhook_endpoints`, `settlement_batches`, and the current `fee_schedules` row. A non-UUID id returns 404.
- `GET /v1/admin/merchants/:id/kyc/documents` and `.../:documentId/file` (finance/super_admin): list and stream KYC files.
- **KYC review** (`onboarding/review.ts`, one transaction with the audit insert): inserts `merchant_kyc_reviews` (outcome, reviewer email, admin user id, notes); `UPDATE merchants SET onboarding_status = outcome, kyc_passed = (outcome='approved')`; writes `admin_audit_log` action `kyc_review`.
- **Adjust balance** (`routes/adminBalanceAdjustments.ts` calls `admin/balanceAdjustments.ts` `adjustMerchantBalanceJournaled`): locks the `merchant_balances` row (404 `merchant_balance_not_found` if the merchant has none); posts a balanced `ledger_entries` group through `postLedgerAdjustment`; `cached_payable_fils += delta`; writes audit action `balance_adjustment_journaled` with before, after and the entry group id, all in one transaction. A delta or resulting balance outside the safe range returns 400 (it used to be 500). Because the ledger is updated, a later "Rebuild balances" keeps the adjustment. Fixed in code, covered by unit tests on a real database (4 new tests; the rebuilt cache was 0 instead of the adjustment before the fix), not exercised in a live browser. Caveats: the audit action name changed from `balance_adjustment`, and about 25 earlier cache-only adjustments in the September audit export are probably already lost to rebuilds (a finance decision). The old helper `applyBalanceCorrection` (cache only) still exists but this route no longer uses it.
- **Issue credit** (`admin/credits.ts`): validates input (`creditRequestValidation.ts`); fee reversal = base x merchant's `mdr_bps` if the box is ticked; inserts `credit_requests` (`pending_approval`). If the base amount is **at most 50,000 fils (50 BD)**, it posts immediately: `ledger_entries` (debit `merchant_credit_contra` / credit `merchant_payable`, plus MDR reversal pair debit `platform_fee_revenue` / credit `merchant_payable` if any) dated at **Bahrain midnight of the effective date** (not `now()`), adds to `merchant_balances.cached_payable_fils`, marks the request `posted`. Above 50 BD it stays `pending_approval` until a different finance/super_admin approves (see Credits page). Audit action `credit_request_created`.
- **Rotate key** (`admin/apiKeys.ts`): in one transaction revokes the old key (`revoked_at`, `revoked_reason='rotated'`), issues a new one in `api_keys` (links back via `rotated_from_key_id`), writes the audit row; returns the raw key once.
- **Recompute statuses** (`routes/adminMerchantsRecompute.ts`): re-derives each transaction's status from its captured and refunded amounts, and reconciles the merchant's test-mode flag; audit `transaction_status_recompute`.
- **Impersonate** (`admin/impersonation.ts`): inserts `admin_impersonation_grants` (token hash, expiry default 15 minutes), audit `impersonation_start`, sets cookie `fp_impersonation`. Grants are read-only: `requireMerchantAuth` refuses any non-GET request made with that cookie, and `requireMerchantWriterActor` refuses writes. Since the audit **every admin role maps to merchant role `support`** (before, `super_admin` mapped to `owner` and `finance` to `finance`). Any admin role may still start a grant; `CLAUDE.md`'s claim of a `super_admin` check is false.

**Database interaction:** Read `merchants`, `merchant_business_profiles`, `merchant_kyc_reviews`, `merchant_balances`, `api_keys`, `webhook_endpoints`, `settlement_batches`, `fee_schedules`, `kyc_documents`. Write `merchant_kyc_reviews`, `merchants`, `merchant_balances`, `credit_requests`, `ledger_entries`, `api_keys`, `transactions`, `admin_impersonation_grants`, `admin_audit_log`.

**Navigation:** Back to merchants; to Credits (from the credit text); to `/webhooks/:merchantId`.

**Validation and security:** Every action is role-gated server side (finance/super_admin for the money-adjacent ones; impersonation and webhook replay for any admin). The role message from the API for a forbidden call is "Not permitted (forbidden) - your admin role does not allow this action."

**Error and loading states:** "Loading merchant..."; load failure shows the error with a "Back to merchants" link; action errors in red, successes in a notice. Buttons are disabled while busy.

**Current implementation status:** Partially Working (code-read, not run).
- KYC review, Issue credit, Rotate key, Recompute statuses, lists: Working.
- Adjust balance: works and is now journaled to the ledger (see above).
- View as merchant: **does not work end to end** (finding D-1, from reading the code, not run live). The admin side works (grant created, audited, banner shown), but the merchant dashboard at `http://localhost:5173` asks `GET /v1/auth/me`, which only accepts the merchant session cookie, not `fp_impersonation`, so the dashboard shows its login page and does not show the merchant's data. The page text "always acts with the support role" is now true (all admin roles map to `support`). Fixing it needs `/me` to accept the grant plus UI work, and an owner decision on who may start impersonation (S-7).
- Default dates in admin date fields now use Bahrain dates, not the browser or UTC (new `apps/admin/src/dates.ts`).

**Relevant source files:** `apps/admin/src/pages/merchants/MerchantDetailPage.tsx`, `apps/admin/src/api/merchants.ts`, `apps/admin/src/api/balanceAdjustments.ts`, `apps/admin/src/api/credits.ts`, `apps/admin/src/api/apiKeys.ts`, `apps/admin/src/api/impersonation.ts`, `apps/api/src/routes/adminMerchants.ts`, `apps/api/src/routes/adminBalanceAdjustments.ts`, `apps/api/src/routes/adminCredits.ts`, `apps/api/src/routes/adminMerchantsRecompute.ts`, `apps/api/src/admin/credits.ts`, `apps/api/src/admin/creditThreshold.ts`, `apps/api/src/admin/balanceAdjustments.ts`, `apps/api/src/admin/ledgerAdjustments.ts`, `apps/api/src/admin/apiKeys.ts`, `apps/api/src/admin/impersonation.ts`, `apps/api/src/onboarding/review.ts`, `apps/api/src/auth/requireMerchantAuth.ts`, `apps/api/src/auth/middleware.ts`

---

### Page: Admin credits (approval queue)

**URL:** `/credits`

**Application:** Admin console (`apps/admin`)

**Purpose:** Approve or reject manual credits that were too large to post immediately.

**Who can access it:** Any admin can view. Approve and Reject are finance and super_admin.

**What the user sees:** "Merchant credits" with an explanation; tab buttons **Awaiting approval**, **Posted**, **Rejected**; a table: Requested by, Merchant (short id link), Reason (and memo), Base, Fee reversal, Posted total, Effective date, Approved by, and Approve/Reject buttons for pending items; "Load more".

**What the user can do (every button/form/filter):** Switch tabs; **Approve**; **Reject** (opens a small panel asking for an optional reason with confirm and cancel buttons); Load more; click a merchant to open its detail page.

**Step-by-step example:** Admin A issues a 120.000 BD credit; it sits in "Awaiting approval". Admin B (different person, finance) clicks Approve: `POST /v1/admin/credits/:id/approve`. The ledger entries are posted and the merchant's cached balance increases.

**What happens in the backend:**
- `GET /v1/admin/credits?status=...` (any admin) reads `credit_requests` joined to `admin_users` for the approver's name.
- `POST /v1/admin/credits/:id/approve` (finance/super_admin; `admin/credits.ts`): locks the request; must be `pending_approval` (409 `credit_request_not_pending`); `assertDistinctApprover` refuses the person who raised it, comparing the **admin user id** (409 `self_approval_forbidden`); display names are no longer compared (fixed in code, covered by new unit tests, not exercised in a live browser); sets approver and time; posts the ledger entries (dated Bahrain midnight of the effective date) and adds to `merchant_balances` exactly like an immediate credit; audit `credit_request_approved`.
- `POST /v1/admin/credits/:id/reject`: marks `rejected` with `rejected_by_admin_user_id`, `rejected_at`; the reason goes only into the audit log (there is no reason column); audit `credit_request_rejected`.

**Database interaction:** Read/write `credit_requests`; write `ledger_entries`, `merchant_balances`, `admin_audit_log`; read `admin_users`.

**Navigation:** To merchant detail.

**Validation and security:** Four-eyes rule enforced on the server. Role gate on server. The approval threshold looks at the base amount only, not base plus fee reversal.

**Error and loading states:** Separate load error, action error, and success notice; buttons disabled while busy; "Nothing here." for an empty tab.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/admin/src/pages/credits/CreditsPage.tsx`, `apps/admin/src/api/credits.ts`, `apps/api/src/routes/adminCredits.ts`, `apps/api/src/admin/credits.ts`, `apps/api/src/admin/creditApproval.ts`, `apps/api/src/admin/creditThreshold.ts`

---

### Page: Admin Settlement ops

**URL:** `/settlement` (admin app; not the same as the merchant `/dashboard/settlement`)

**Application:** Admin console (`apps/admin`)

**Purpose:** Manually trigger settlement-related operations: run a day's batch, rebuild cached balances, rebuild analytics, recalculate MDR fees.

**Who can access it:** Everyone can open the page, but each section shows a "Your role cannot..." message unless the admin is finance or super_admin; the server enforces the same.

**What the user sees:** Four sections.

**What the user can do (every button/form/filter):**
1. **Re-run a daily batch:** Business date, optional Merchant id, **Run batch**. Result table: Merchant, Batch, Gross, Fee, Net payout, Already closed, Already paid.
2. **Rebuild cached balances:** **Rebuild balances**, then a confirm panel "Rebuild balances for every merchant?" with **Yes, rebuild all balances** / **Cancel**. Result: counts and a Before/After table of changed merchants.
3. **Rebuild analytics:** **Rebuild analytics** then confirm; result "Rebuilt N daily-volume rows and M payout-trend rows."
4. **Recalculate MDR:** Merchant id, From (inclusive), To (exclusive), **Recalculate MDR**. Result: batches considered, adjustments table (Batch date, Status, Old fee, New fee, Difference).

**Step-by-step example (re-run):** Choose yesterday's date, leave merchant blank, click Run batch. The API writes an audit row first, then asks the Go settlement service to close and pay every eligible merchant's batch for that date. Running a date that is already done is reported as "already closed / already paid" and changes nothing.

**What happens in the backend:** (`routes/admin.ts`, `admin/settlementClient.ts`)
- `POST /v1/admin/settlement/run-batch` `{date (YYYY-MM-DD), merchantId?}` (finance/super_admin): validates; **commits an `admin_audit_log` row first** (`settlement_run_batch`); then calls the Go service's internal endpoint `/internal/run-batch` with a bearer token; afterwards records `succeeded` or `failed` on the audit row. If the audit write fails, the call never happens. The Go service (`internal/settlement/batch.go`) for each eligible merchant (active, not test mode): `CloseBatch` (select captured events in the Bahrain business-day window, compute fees, write `settlement_batches`, `scheme_export_lines`, rounding-residue `ledger_entries`, an `outbox_events` row `settlement.batch_closed`, update `merchant_balances`), then `PayoutBatch` (ledger legs debit `merchant_payable` / credit `platform_cash`, status `paid`, a `settlement_payout_disbursements` row, balance cache reduced). Split-parent merchants use `PayoutSplitBatch`. Each merchant is handled independently (`settleOneMerchant`): if one fails, the others are still settled, and the Go service then answers HTTP 500 `run_batch_partial_failure` with a `failedMerchants` list, which the admin page shows as an error even though the healthy merchants were settled. The scheduled daemon (not this button) closes the previous Bahrain day about 00:15 Bahrain time.
- `POST /v1/admin/balances/rebuild` (finance/super_admin): same two-phase audit; the Go service recomputes `merchant_balances` from `ledger_entries` (the authority).
- `POST /v1/admin/reporting/rebuild` (finance/super_admin): runs inside the API process in one transaction (`admin/reportingRebuild.ts`), truncating and replaying `merchant_daily_volume` and `merchant_payout_trends` from the outbox, plus an audit row `reporting_rebuild`.
- `POST /v1/admin/merchants/:id/mdr-recalculation` `{from,to}`: two-phase audit; Go service re-derives `closed` batches' fees at the current rate and posts adjustments (paid batches are not modified).

**Database interaction:** Write `admin_audit_log`; via Go: `settlement_batches`, `transaction_events`, `scheme_export_lines`, `ledger_entries`, `outbox_events`, `merchant_balances`, `settlement_payout_disbursements`, `platform_stats`; rebuild analytics: `merchant_daily_volume`, `merchant_payout_trends`.

**Navigation:** None.

**Validation and security:** Server role gate; dates validated as `YYYY-MM-DD`; merchant id must be a UUID; the Go endpoints need a shared internal bearer token. The settlement business day is the **Asia/Bahrain** calendar day (UTC+3) per `window.go`, not UTC midnight; `CLAUDE.md` says the opposite and is wrong.

**Error and loading states:** Each section has its own error paragraph and busy label ("Running...", "Rebuilding...", "Recalculating...").

**Current implementation status:** Partially Working / Not Verified (code-read, not run). The pages and endpoints are wired consistently, but the actions depend on the Go service being up and configured with the internal token and were not exercised; the Go `internal/ledger` package has 2 failing tests at baseline, relevant to the balance rebuild.

**Relevant source files:** `apps/admin/src/pages/settlement/SettlementPage.tsx`, `apps/admin/src/api/settlement.ts`, `apps/admin/src/api/mdrRecalculation.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/admin/settlementClient.ts`, `apps/api/src/admin/reportingRebuild.ts`, `apps/settlement/internal/settlement/batch.go`, `apps/settlement/internal/settlement/window.go`, `apps/settlement/internal/internalapi/server.go`, `apps/settlement/internal/ledger/rebuild.go`, `apps/settlement/internal/settlement/recalculate_mdr.go`

---

### Page: Admin adjustment imports

**URL:** `/adjustment-imports`

**Application:** Admin console (`apps/admin`)

**Purpose:** Apply many manual balance corrections at once from a CSV.

**Who can access it:** Any admin can see the history; the upload form is finance and super_admin.

**What the user sees:** "Import adjustments"; a form with "File name (optional)", a CSV text area (columns `merchantId,amount,reason`; amount in BD with up to 3 decimals, for example `4.750`) and **Apply**; "Past imports" table (Applied, File, Rows, **View rows** / **Hide rows**); a Rows table (#, Merchant, CSV amount as typed, Posted in BD, Reason).

**What the user can do (every button/form/filter):** Paste CSV text and click **Apply**; open or close a past import's rows.

**Step-by-step example:** Paste `merchantId,amount,reason` followed by `<uuid>,4.750,statement correction` and click Apply. The page calls `POST /v1/admin/adjustment-imports`; notice "Applied 1 row(s), posting 4.750 BHD in total."

**What happens in the backend:** (`routes/adminAdjustmentImport.ts`, `admin/adjustmentImport.ts`, `admin/adjustmentCsvParsing.ts`) finance/super_admin; `csvContent` must be a non-empty string; every row's merchant id must be a UUID (400 `invalid_csv_row`). Rows are applied immediately in one go (no preview step). Duplicate content is rejected (content hash plus a unique index). Per row: balanced `ledger_entries` via `postLedgerAdjustment`, `merchant_balances` update, `adjustment_import_rows` record (raw amount text beside the parsed integer fils). Also an `adjustment_imports` header row. `GET /v1/admin/adjustment-imports` lists history (any admin); `GET .../:id/rows` returns rows (404 if none).

**Database interaction:** Write `adjustment_imports`, `adjustment_import_rows`, `ledger_entries`, `merchant_balances`; read the same.

**Navigation:** None.

**Validation and security:** Server role gate; amounts parsed to integer fils (`4.750` becomes `4750`); the parsing was written to handle 3 decimal places correctly.

**Error and loading states:** Error paragraph; "Applying..." label; "No imports yet.".

**Current implementation status:** Working (code-read, not run). Risk: applies money movements instantly with no preview, and a single finance admin can apply any amount with no second approver or row cap (open decision S-5). Audit fix: a reason containing commas used to be cut at the third comma and is now kept whole. Four locked CSV unit tests still fail because they assume 100 units per BD while the code correctly uses 1000. The migration 0073 duplicate-content check exists although `docs/ADMIN.md` says there is none.

**Relevant source files:** `apps/admin/src/pages/adjustments/AdjustmentImportPage.tsx`, `apps/admin/src/api/adjustmentImports.ts`, `apps/api/src/routes/adminAdjustmentImport.ts`, `apps/api/src/admin/adjustmentImport.ts`, `apps/api/src/admin/adjustmentCsvParsing.ts`, `apps/api/src/admin/ledgerAdjustments.ts`

---

### Page: Admin webhook replay (pick merchant)

**URL:** `/webhooks`

**Application:** Admin console (`apps/admin`)

**Purpose:** First step of replaying failed webhooks: find the merchant.

**Who can access it:** Any admin role.

**What the user sees:** "Webhook replay / Pick the merchant whose endpoint needs a replay.", a Search merchants box, a **Search** button, and a list of up to 10 matching merchants as buttons with their ids.

**What the user can do (every button/form/filter):** Search; click a merchant, which navigates to `/webhooks/<merchantId>`.

**Step-by-step example:** Search "bakery", click "Dana Bakery".

**What happens in the backend:** `GET /v1/admin/merchants?q=bakery&limit=10` (any admin).

**Database interaction:** Read `merchants`, `merchant_business_profiles`.

**Navigation:** To `/webhooks/:merchantId`.

**Validation and security:** Any admin session.

**Error and loading states:** Red error paragraph.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/admin/src/pages/webhooks/WebhookReplayPage.tsx`, `apps/admin/src/api/merchants.ts`, `apps/api/src/routes/adminMerchants.ts`

---

### Page: Admin webhook replay (batch replay for one merchant)

**URL:** `/webhooks/:merchantId`

**Application:** Admin console (`apps/admin`)

**Purpose:** Re-queue many past webhook deliveries for one endpoint after an outage.

**Who can access it:** Any admin role (replay is considered routine and reversible; no money moves directly).

**What the user sees:** "Pick a different merchant" link, merchant name (link to detail), a form: **Endpoint** dropdown (the merchant's endpoints with status, first active one preselected), **From** and **To** date-time pickers (default last 7 days), **Delivery statuses to replay** checkboxes (exhausted, failed, pending, succeeded; default only `exhausted`), **Replay batch**. Result: "Matched N deliveries; queued M replays. They are sent by the normal async dispatcher pass..." with the list of new delivery ids. If the merchant has no endpoints: a message saying so.

**What the user can do (every button/form/filter):** Choose endpoint, time range and statuses; click Replay batch. (Replaying a `succeeded` delivery is allowed and re-sends something the receiver already accepted.)

**Step-by-step example:** The merchant's server was down yesterday; deliveries ended `exhausted`. Pick the endpoint, From = yesterday morning, To = now, leave `exhausted` ticked, click Replay batch.

**What happens in the backend:** `POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/replay-batch` `{from,to,statuses?}` (any admin; `webhooks/replayBatch.ts`): `from` and `to` required valid ISO times with `from < to` (400); `statuses` default `["exhausted"]`; endpoint must belong to the merchant (404 `webhook_endpoint_not_found`) and be `active` (409 `endpoint_disabled`). Selects up to **500** matching `webhook_deliveries` created in the range, and for each inserts a new `pending` delivery (same as a single merchant replay: new `delivery_event_id`, `replay_of_delivery_id` set). Writes audit `webhook_batch_replay` with the new ids. The actual sending is done later by the dispatcher.

**Database interaction:** Read `webhook_endpoints`, `webhook_deliveries`; write `webhook_deliveries`, `admin_audit_log`.

**Navigation:** Links back to the merchant picker and merchant detail.

**Validation and security:** Server validates times and ownership. Two more admin endpoints exist (`.../archive` to snapshot delivery history and `.../archive/:archiveId/replay` to restore it onto a possibly different endpoint), but this page has no UI for them.

**Error and loading states:** Red error; "Replaying..." label; submit disabled until an endpoint is chosen.

**Current implementation status:** Working (code-read, not run). `docs/ADMIN.md:89` and a code comment claim replays keep the original delivery id so receivers can de-duplicate; the code creates a fresh `delivery_event_id` (and writes it into the payload `id`), so de-duplication by that id will not catch replays. Any admin role can replay or archive (open item S-21).

**Relevant source files:** `apps/admin/src/pages/webhooks/WebhookReplayPage.tsx`, `apps/admin/src/api/webhooks.ts`, `apps/api/src/routes/adminMerchants.ts`, `apps/api/src/webhooks/replayBatch.ts`, `apps/api/src/webhooks/replay.ts`, `apps/api/src/webhooks/archiveReplay.ts`

---

### Page: Admin "page not found" and error screens

**URL:** any unknown admin address (`*`), and render errors on `/login` and the shell routes.

**Application:** Admin console (`apps/admin`)

**Purpose:** Same idea as the dashboard fallback.

**Who can access it:** Anyone who reaches the admin app.

**What the user sees:** "Page not found / The address may be incorrect..." or "This page could not be loaded" with the error text, and a link "Return to the admin console" (to `/`, which goes to `/merchants`, or to `/login` if signed out).

**What the user can do (every button/form/filter):** Click the link.

**Step-by-step example:** Visit `/refunds` in the admin app: no such route, so "Page not found" appears.

**What happens in the backend:** Nothing.

**Database interaction:** None.

**Navigation:** `/`.

**Validation and security:** None.

**Error and loading states:** This is the error state.

**Current implementation status:** Working (code-read, not run).

**Relevant source files:** `apps/admin/src/components/RouteFallback.tsx`, `apps/admin/src/router.tsx`

---

## Appendix A: Things the API offers that no page uses

These exist in `apps/api` but have no screen. Do not assume the dashboard can do them.

| Endpoint | What it does | Who may call |
|---|---|---|
| `POST /v1/transactions` | Authorize a payment (server to server with an API key) | Merchant API key only |
| `GET /v1/transactions/export` | CSV export, maximum 31-day window | Merchant auth |
| `POST/GET/DELETE /v1/merchants/:id/api-keys` | Merchant issues, lists, revokes API keys | Merchant `owner` |
| `PATCH /v1/merchants/:id/business-profile` | Edit business profile | owner/finance |
| `GET /v1/settlement/summary` | Settlement summary for a date range | owner/finance |
| `GET /v1/analytics/recent-ledger-activity` | Recent ledger rows | Merchant auth |
| `GET/POST /v1/reporting/transactions`, `/saved-filters`, `/export-summary` | Saved report filters | Merchant auth |
| `POST /v1/acquirer/...` callbacks | Acquirer notifications, signature verified | Public, signature is the only auth |
| `.../webhook-endpoints/:id/archive` and `.../archive/:archiveId/replay` | Archive and restore delivery history | Any admin |
| `POST /v1/refunds` | Refund stub | Returns 501 |

## Appendix B: Honest summary table

| Page | Status (code-read, not run) |
|---|---|
| Root redirect | Working |
| Public checkout `/pay/:token` | Working |
| Merchant login | Working |
| Merchant register | Working |
| Dashboard shell | Working |
| Onboarding | Working |
| Transactions list | Working |
| Transaction detail: capture and void | Working (now owner/finance only for sessions) |
| Transaction detail: refund / RefundDrawer | **Not Implemented** (501; drawer fully commented out; its old code targeted a route that does not exist) |
| Payment links list / new | Working |
| Payment link detail | Partially Working (100-most-recent limit) |
| Settlement list / detail | Working |
| Reconciliation | Not Verified |
| Webhooks list / new / detail | Working |
| Overview | Working (needs reporting worker) |
| Dashboard 404 / error | Working |
| Admin login | Working |
| Admin shell | Working |
| Admin merchants list | Working |
| Admin merchant detail | Partially Working (balance adjust now journaled; **View as merchant does not work end to end**, D-1) |
| Admin credits | Working |
| Admin settlement ops | Partially Working / Not Verified |
| Admin adjustment imports | Working |
| Admin webhook replay (both) | Working |
| Admin 404 / error | Working |
