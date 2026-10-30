# FilsPay API explained

Source of truth: `apps/api/src/app.ts` (route registration) and the files in
`apps/api/src/routes/`. This page lists every endpoint that is actually
registered. Refreshed from the current source on 2026-10-30, after the audit
fixes. Where a fix was reported by an audit agent and only covered by unit
tests, the page says "fixed in code, covered by unit tests, not exercised in a
live browser".

Money rule: every amount in the API is an **integer number of fils**
(1 BD = 1000 fils). `amountFils: 10000` means 10.000 BD. The older text in
`CLAUDE.md` / `AGENTS.md` that says "cents" is wrong.

Total registered endpoints: **82**.

---

## 1. Things that apply to every endpoint

### Base URL and CORS
Local API: `http://localhost:3000`. Browsers on `http://localhost:5173` (merchant
web) and `http://localhost:5174` (admin) are allowed with credentials. Allowed
request headers: `Content-Type, Authorization, Idempotency-Key`.

### The six ways a request can be authenticated

| Label used below | What it is | How the client sends it |
|---|---|---|
| **public** | No authentication | nothing |
| **session** | Merchant user who signed in with password + OTP | cookie `fp_sid` (HttpOnly) |
| **merchantAuth** | Session OR API key OR admin impersonation grant (checked in that order) | cookie `fp_sid`, or `Authorization: Bearer <api key>`, or cookie `fp_impersonation` |
| **api key** | Only an API key | `Authorization: Bearer <api key>` |
| **admin session** | Admin console user who signed in with password + OTP | cookie `fp_admin_sid` |
| **signature** | Acquirer callback | header `Acquirer-Callback-Signature: t=<unix>,v1=<hex hmac>` |

Facts about `merchantAuth` (`apps/api/src/auth/requireMerchantAuth.ts`):

- Handlers take the merchant id from the credential, **not** from the body.
- An impersonation grant is **read-only**: any method other than GET/HEAD/OPTIONS
  gets `403 forbidden`. Every admin role maps to merchant role `support` for the
  grant (see section 10.2).
- `requireMerchantRole(...)` lets **API keys through always** (an API key has
  no role). Sessions are checked against the role list. A leaked key therefore
  passes every role check, for example it can register a webhook URL (open
  finding S-8, needs a product decision).
- `requireSession` (older helper, used by auth/KYC/profile/API-key routes) only
  accepts a fully signed-in session cookie, never an API key or impersonation.

### Roles
- Merchant roles: `owner`, `finance`, `support`.
- Admin roles: `support`, `finance`, `super_admin`.

### Error shape
Errors are JSON like `{ "error": "<code>", "message": "..." }`. Common codes:

| Status | Code examples | Meaning |
|---|---|---|
| 400 | `invalid_request`, `invalid_amount`, `amount_too_large`, `idempotency_key_required` | Bad or missing input. Malformed ids, `limit=abc`, bad dates and tampered cursors now also return 400/404 instead of 500 (fixed in code, covered by unit tests, not exercised in a live browser) |
| 401 | `unauthenticated`, `invalid_credentials`, `invalid_code`, `no_pending_session` | Not signed in / wrong code |
| 403 | `forbidden` | Wrong merchant in path, wrong role, or write while impersonating |
| 404 | `transaction_not_found`, `merchant_not_found`, ... | Not found (or not yours) |
| 409 | `not_capturable`, `not_cancelable`, `merchant_selection_required` | State conflict |
| 410 | `otp_expired` | OTP no longer valid |
| 422 | `capture_exceeds_remaining`, `idempotency_key_reused` | Valid JSON, rejected by rules |
| 429 | `too_many_attempts`, `resend_too_soon`, `rate_limited` | Attempt budget, resend throttle, or the in-memory rate limiter (see "Rate limiting" below). `rate_limited` carries a `Retry-After` header |
| 501 | `not_implemented` | Refunds |
| 502/503 | `acquirer_unavailable`, `otp_delivery_unavailable` | Upstream failed |

### Idempotency-Key
`POST /v1/transactions` (authorize), `POST /v1/transactions/:id/capture` and
`POST /v1/payment-links/:token/pay` **require** an `Idempotency-Key` header.
Sending the same key + same body again replays the first response. Same key +
different body gives `422 idempotency_key_reused`. Void does not need a key.

Framework errors that already carry a 4xx status (bad JSON 400, payload too
large 413, unsupported media type 415) keep that status. Before the audit they
all became 500.

### Rate limiting (new in the audit)
`lib/rateLimit.ts` is an in-memory fixed-window limiter, registered as one
app-level hook. Over the limit the API answers `429 rate_limited` with a
`Retry-After` header. Defaults:

| Rule | Limit | Key |
|---|---|---|
| Merchant login (`/v1/auth/login`, `/email-login`) | 10 per minute | IP + email |
| OTP verify and resend (merchant and admin) | 10 per minute | IP |
| Admin login | 10 per minute | IP + email |
| Public pay (`/v1/payment-links/:token/pay`) | 20 per minute | IP + token |
| Signup (`POST /v1/merchants`) | 10 per hour | IP |

It is **off when `NODE_ENV=test`** unless `RATE_LIMIT_ENABLED=true`. The counters
live in one process, so several API replicas multiply the limit. Behind a load
balancer set `TRUST_PROXY`, otherwise every client looks like one IP. The
limits can be changed with `RATE_LIMIT_*` environment variables. Fixed in code,
covered by unit tests, not exercised in a live browser.

### Local dev OTP
When `OTP_DEV_EXPOSE` is on (default outside production), login responses
include `devOtpCode` so you can finish the sign-in without email/SMS.
OTP codes are generated with `crypto.randomInt`. The verify attempt budget (5)
carries across resends, exhausting it revokes the session, and resend is
throttled to once per 30 seconds.

---

## 2. Health

| Method + path | Auth | Purpose | Response | Tables | Frontend |
|---|---|---|---|---|---|
| `GET /healthz` | public | Liveness. Never touches the DB. | `200 { status: "ok", uptimeSeconds }` | none | none |
| `GET /readyz` | public | Readiness. Only reports whether the DB connected **once at boot**; it does not re-check. | `200 { status: "ready" }` or `503 { status: "not_ready" }` | none | none |

---

## 3. Merchant authentication  (prefix `/v1/auth`)

Two-step sign-in: password creates a **pending** session cookie + OTP challenge;
`/otp/verify` promotes it to a real session (12 h by default). When config
`rotateSessionOnOtpVerify` is on (env `ROTATE_SESSION_ON_OTP_VERIFY`, default
**ON in production, OFF elsewhere**), verify also issues a **new** session
token, which prevents session fixation. The same switch applies to admin
sessions. The locked route tests reuse the pre-verify cookie, so rotation is off
by default outside production; only `auth/otpSessionRotation.new.test.ts` checks
it.

| Method + path | Auth | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `POST /v1/auth/login` | public | Legacy login when you already know the merchant id | `{ merchantId, email, password }` (all required) | `200 { otpRequired: true, otpExpiresAt, devOtpCode? }` and sets pending cookie | 400, 401 `invalid_credentials`, 409 `merchant_selection_required` (lists businesses), 503 | merchant_users, merchants, otp_challenges, sessions | dashboard login |
| `POST /v1/auth/email-login` | public | Login by email + password, optional `merchantId` / `registrationNumber` to disambiguate. At most `LOGIN_MAX_CANDIDATES` (default 5) matching businesses are checked; with more than 5 businesses on one email the caller must send `merchantId` or `registrationNumber` | `{ email, password, merchantId?, registrationNumber? }` | same as above | same as above | + merchant_business_profiles | `/dashboard/login` |
| `POST /v1/auth/otp/verify` | pending-session cookie | Check the OTP and promote the session (rotates the token when the rotation setting is on) | `{ code }` | `200 { authenticated: true, merchantId, role }`, cookie lifetime extended | 401 `no_pending_session` / `invalid_code`, 410 `otp_expired`, 429 `too_many_attempts` | otp_challenges, sessions, merchant_users | login page (OTP step) |
| `POST /v1/auth/otp/resend` | pending-session cookie | New OTP. At most once per 30 s; failed-attempt count is carried over so resend cannot reset the guess budget | none | `200 { otpRequired, otpExpiresAt, devOtpCode? }` | 401, 410, 429 `resend_too_soon` / `too_many_attempts`, 503 | otp_challenges, sessions | login page |
| `GET /v1/auth/me` | session | Who am I | none | `{ merchantUserId, email, role, merchant: { id, displayName, onboardingStatus } }` | 401 | merchant_users, merchants | dashboard shell (every page) |
| `POST /v1/auth/logout` | session | Revoke session and clear cookie | none | `204` | 401 | sessions | dashboard header |

---

## 4. Merchant area  (prefix `/v1/merchants`)

Every route with `:merchantId` checks that it equals the merchant on the
credential, else `403 forbidden`.

### 4.1 Signup, profile, KYC, API keys

| Method + path | Auth / roles | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `POST /v1/merchants` | public | Sign up a new merchant + owner user | `{ businessProfile: { legalName, registrationNumber, contactEmail, contactPhone, addressLine1, city, businessType, country? }, owner: { email, password >= 12 chars } }`. `businessType` is one of `sole_proprietorship, llc, partnership, public_company, other`. Rate limited: 10 per hour per IP | `201 { merchantId, ownerUserId, onboardingStatus }` | 400 `invalid_request`, `invalid_business_type`, `invalid_email`, `weak_password`, `invalid_country` | merchants, merchant_users, merchant_business_profiles | `/dashboard/register` |
| `GET /v1/merchants/:merchantId/business-profile` | session (any role) | Read business profile | path | profile JSON | 403, 404 | merchant_business_profiles | `/dashboard/onboarding` |
| `PATCH /v1/merchants/:merchantId/business-profile` | session, owner or finance | Update profile fields. Unknown keys (including inherited names such as `constructor`) are rejected and values are validated | partial profile | updated profile | 403, 400 | merchant_business_profiles | `/dashboard/onboarding` |
| `POST /v1/merchants/:merchantId/kyc/documents` | session, owner or finance | Upload a KYC document (multipart: `documentType` field + one file). Types: `commercial_registration` and `bank_letter` (PDF only, checked by file bytes), `owner_id`, `proof_of_address`. The stored file name is sanitised; multipart is limited to 1 file and 10 fields | multipart | `201` recorded document | 400 `invalid_request` | kyc_documents (+ file on disk) | `/dashboard/onboarding` |
| `GET /v1/merchants/:merchantId/kyc/documents` | session, any role | List uploaded documents | path | list | 403 | kyc_documents | onboarding |
| `GET /v1/merchants/:merchantId/kyc/documents/:documentId/file` | session, owner or finance | Download original file | path | file bytes, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` | 403, 404 | kyc_documents | onboarding |
| `GET /v1/merchants/:merchantId/kyc/documents/:documentId/thumbnail` | session, owner or finance | Thumbnail image | path | image bytes | 403, 404 | kyc_documents | onboarding |
| `POST /v1/merchants/:merchantId/api-keys` | session, **owner** only | Create an API key. The raw key is shown **once** | `{ label? }` | `201 { id, prefix, rawKey, createdAt }` | 403 | api_keys | no dashboard page found in `apps/web` router (use API directly) |
| `GET /v1/merchants/:merchantId/api-keys` | session, owner | List keys (prefix only, never the raw key) | path | list | 403 | api_keys | none |
| `DELETE /v1/merchants/:merchantId/api-keys/:id` | session, owner | Revoke a key | path | `204` | 404 `api_key_not_found` | api_keys | none |

### 4.2 Payment links (merchant side)

| Method + path | Auth / roles | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `POST /v1/merchants/:merchantId/payment-links` | merchantAuth, owner or finance (API key allowed) | Create a link customers can pay. The token is `plink_` + 22 characters from `crypto.randomInt` | `{ amountFils, expiresAt, reference?, description? }` | `201` link (includes the public token/URL) | 400 `invalid_request`, 403 (impersonation cannot write) | payment_links | `/dashboard/payment-links/new` |
| `GET /v1/merchants/:merchantId/payment-links` | merchantAuth, any role | List links | query `status` (repeatable), `limit`, `cursor` | page of links + cursor | 403 | payment_links | `/dashboard/payment-links` and detail |
| `DELETE /v1/merchants/:merchantId/payment-links/:id` | merchantAuth, owner or finance | Cancel an active link | path | `204` | 404 `payment_link_not_found`, 409 `not_cancelable` | payment_links | payment link detail |

### 4.3 Webhook endpoints (merchant side)

All need `merchantAuth`; owner or finance unless noted. See section 9 for how
delivery works.

| Method + path | Roles | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `POST /v1/merchants/:merchantId/webhook-endpoints` | owner, finance | Register a receiver URL. Secret shown **once** | `{ url }` (in production: https required, and the host's DNS answers are checked against a private-range blocklist) | `201 { id, url, secretPrefix, status, createdAt, secret }` | 400 | webhook_endpoints | `/dashboard/webhooks/new` |
| `GET .../webhook-endpoints` | owner, finance | List endpoints | path | array | 403 | webhook_endpoints | `/dashboard/webhooks` |
| `PATCH .../webhook-endpoints/:id` | owner, finance | Change url (same checks as create) or `status` (`active` / `disabled`) | `{ url?, status? }` | updated endpoint | 404 `webhook_endpoint_not_found` | webhook_endpoints | endpoint detail |
| `DELETE .../webhook-endpoints/:id` | owner, finance | Remove an endpoint (soft delete, migration 0081) | path | `204` | 404 | webhook_endpoints | endpoint detail |
| `POST .../webhook-endpoints/:id/test` | owner, finance | Send a signed test event **synchronously** and report what the receiver answered | path | `200` result with receiver status and short body excerpt | 404 (also for a deleted endpoint) | webhook_endpoints | endpoint detail |
| `POST .../webhook-endpoints/:id/deliveries/:deliveryId/replay` | owner, finance | Re-queue one past delivery as a **new** delivery row with a **new** delivery id (the envelope `id` matches the new id) | path | `202` | 404, 409 `endpoint_disabled` | webhook_deliveries | endpoint detail |
| `GET .../webhook-endpoints/:id/deliveries` | owner, finance, support | Delivery log | query `status`, `limit`, `cursor` | `{ deliveries, nextCursor }` | 404 | webhook_deliveries | endpoint detail |
| `GET .../webhook-endpoints/:id/deliveries/:deliveryId` | owner, finance, support | One delivery with attempt details | path | delivery | 404 `webhook_delivery_not_found` (also 404 when the endpoint was deleted) | webhook_deliveries | endpoint detail |

(`...` = `/v1/merchants/:merchantId`.)

---

## 5. Payments  (prefix `/v1/transactions`)

Amounts are `amountFils` (integer). Order of life of a card payment:
**authorize -> capture** (or **void**).

| Method + path | Auth / roles | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `POST /v1/transactions` | **api key only**; `Idempotency-Key` required | Authorize a card (reserve money). Creates a hold. `amountFils` must be a whole number greater than 0 and at most 99,999,999,990 fils (99,999,999.990 BD, the limit of the settlement scheme file column); checked before any acquirer call. The acquirer idempotency key is derived from the merchant, endpoint, the caller's key and the request hash, so a retry reaches the acquirer with the same key | `{ amountFils, card: {...simulated card}, reference? }` | `201` transaction (status `authorized`) | 400 `invalid_amount` / `amount_too_large`, 402 `card_declined` (+ `declineReason`; no transaction row is created), 403 merchant not approved/active, 502 | idempotency_keys, merchants, transactions, holds, transaction_events | none (server-to-server) |
| `POST /v1/transactions/:id/capture` | merchantAuth; session actors need role **owner or finance** (API keys pass; impersonation refused); `Idempotency-Key` required | Capture all remaining, or a partial `amountFils`. Takes the fee, writes ledger | `{ amountFils? }` | `200` transaction (`captured` or `partially_captured`) | 404 `transaction_not_found`, 409 `not_capturable`, 422 `capture_exceeds_remaining`, 402 `card_captured_declined`, 502 | transactions, ledger_entries, holds, outbox_events, transaction_events, idempotency_keys, fee_schedules | transaction detail |
| `POST /v1/transactions/:id/void` | merchantAuth; session actors need role **owner or finance** (API keys pass; impersonation refused) | Cancel an authorization and release the hold | none | `200`-style result from `voidTransaction` | 403, 404, 409 | transactions, holds, transaction_events, outbox_events | transaction detail |
| `GET /v1/transactions` | merchantAuth | List own transactions | query `status` (repeatable), `from`, `to`, `search`, `limit`, `cursor` | page + cursor | - | transactions | `/dashboard/transactions` |
| `GET /v1/transactions/export` | merchantAuth | CSV export. `from` and `to` (ISO instants) are **required**, window max 31 days | query `from`, `to`, `status?` | `text/csv` attachment `transactions.csv` | 400 `export_date_range_required`, `invalid_export_date_range`, `export_date_range_too_large` | transactions | transactions list |
| `GET /v1/transactions/:id` | merchantAuth | One transaction | path | transaction | 404 | transactions | `/dashboard/transactions/:id` |
| `GET /v1/transactions/:id/events` | merchantAuth | Audit trail (authorized, captured, voided...) | path | event list | 404 | transaction_events | transaction detail |

Not registered: `apps/api/src/v1/routes/transactions.ts` contains an
unauthenticated "capture" handler. `app.ts` never imports it (a comment in
`app.ts` says that tree is dead), so it is dead code and not an endpoint. Delete
it once the owner agrees.

### Public payment links (customer side)  (prefix `/v1/payment-links`)

| Method + path | Auth | Purpose | Body / params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `GET /v1/payment-links/:token` | public | What the checkout page shows (amount, description, status). It no longer exposes the merchant's API key hash: `merchantIntegrationId` is now the (non-secret) merchant id. `merchantPublicKey` (the 16-character key prefix) is still returned because a locked test expects it | path token | public link JSON | 404 `payment_link_not_found` | payment_links | `/pay/:token` |
| `POST /v1/payment-links/:token/pay` | public; `Idempotency-Key` required | Pay a link: reserves the link, authorizes, captures, marks it `paid`. `submittedAt` is honoured only when a valid API key of the link's **owning merchant** is also sent (offline terminals); otherwise server time is used. If the final "mark paid" step matches 0 rows, the link is re-read: same transaction -> idempotent `200`; a different transaction -> `409 payment_link_double_charge` (logged loudly). Rate limited: 20 per minute per IP and token | `{ card, submittedAt? }` | status and body from the authorize/capture step | 400, 402, 404, 409, 429 | payment_links, transactions, holds, ledger_entries, outbox_events | `/pay/:token` |

---

## 6. Refunds  (prefix `/v1/refunds`)

| Method + path | Auth | Purpose | Response |
|---|---|---|---|
| `POST /v1/refunds` | merchantAuth | **Stub.** Always replies `501 { "error": "not_implemented" }` after authentication | `501` |

Honest status: the building blocks exist (`payments/processRefund.ts`,
`payments/refundValidation.ts`, `refunds/initiateMerchantRefund.ts`, a
`refunds` table, `calculateRefundFee` in `packages/money`), but **no route
calls them**. `RefundDrawer.tsx` in the web app is entirely commented out
(`export {}`), so the UI cannot start a refund. Project rules say the stub must
stay until the refund work (FP-212) is decided.

Audit change at the helper layer only: a blank or missing refund reason now
becomes `"unspecified"` (before, an explicit NULL broke the `reason` constraint),
and the helper checks merchant ownership inside the locked read (another
merchant's transaction returns 404 and writes nothing). Fixed in code, covered
by unit tests, not wired to any route. Open decisions before wiring: status
after a full refund of a partial capture, fee reversal vs the volume-tier
bonus, role/scope checks on the route, and permanent storage of failures under
the idempotency key (see `AGENT_TASKS.md`, REFUND-1).

---

## 7. Settlement (merchant read-only)  (prefix `/v1/settlement`)

Settlement is **computed by the Go service** (`apps/settlement`). These
endpoints only read the results. All use `merchantAuth`.

| Method + path | Roles | Purpose | Params | Response | Errors | Tables | Frontend |
|---|---|---|---|---|---|---|---|
| `GET /v1/settlement/batches` | any | List daily batches | query `from`, `to`, `status` (repeatable), `limit`, `cursor` | page of batches | - | settlement_batches | `/dashboard/settlement` |
| `GET /v1/settlement/batches/:id` | any | One batch (gross, fee, net, status) | path | batch | 404 `settlement_batch_not_found` | settlement_batches | `/dashboard/settlement/:id` |
| `GET /v1/settlement/batches/:id/transactions` | any | Transactions inside a batch | path | `{ transactions }` | 404 | settlement_batches, transaction_events, transactions | batch detail |
| `GET /v1/settlement/reconciliation` | owner, finance | Reconciliation report for a date range | query `from`, `to` as `YYYY-MM-DD` (both required, `to` exclusive) | report | 400 `invalid_request` | settlement_batches, ledger_entries and related | `/dashboard/reconciliation` |
| `GET /v1/settlement/summary` | owner, finance | Totals for a date range | same query | summary | 400 | settlement_batches | reconciliation / overview |

Business dates are in **Asia/Bahrain** (UTC+3).

---

## 8. Analytics and reporting (merchant, read-only)

All `merchantAuth`, any role, always scoped to the caller's merchant.

| Method + path | Purpose | Params | Tables | Frontend |
|---|---|---|---|---|
| `GET /v1/analytics/volumes` | Daily captured volume | query `from`, `to` (`YYYY-MM-DD`, default last 30 days in Bahrain time; 400 `invalid_date`) | merchant_daily_volume | `/dashboard/overview` |
| `GET /v1/analytics/payout-trends` | Payout trend per batch | same | merchant_payout_trends | overview |
| `GET /v1/analytics/recent-ledger-activity` | Recent ledger lines | same | ledger_entries | overview |
| `GET /v1/analytics/top-links` | Best-paying payment links | same + `limit` (clamped) | payment_links | overview |
| `GET /v1/reporting/transactions` | Filtered transaction report | query `filter` = JSON string `{ merchantId?, status?, from?, to? }`; 400 `invalid_filter` | transactions | (no dedicated page found) |
| `POST /v1/reporting/saved-filters` | Save a filter. Capped at 50 per merchant (409 when full), name up to 100 characters, filter up to 8 KB | `{ name, filter }` -> `201` | reporting_saved_filters | none found |
| `GET /v1/reporting/saved-filters` | List saved filters | - | reporting_saved_filters | none found |
| `GET /v1/reporting/export-summary` | Count of days and total gross | - | merchant_daily_volume | none found |

Note: `/v1/reporting/transactions` accepts a `merchantId` in the filter and
passes it through `resolveReportMerchantId` (`reporting/scope.ts`). Read that
function before relying on it for isolation; it has not been audited in this
document.

---

## 9. Acquirer callbacks and webhooks (inbound and outbound)

### Inbound: acquirer to FilsPay  (prefix `/v1/acquirer`)

| Method + path | Auth | Purpose | Body | Response | Errors | Tables |
|---|---|---|---|---|---|---|
| `POST /v1/acquirer/callbacks` | **signature**: header `Acquirer-Callback-Signature: t=<unix>,v1=<hex HMAC>` | Deliver a delayed fraud-review result | `{ callbackId, type: "fraud_review.completed", transactionId, occurredAt, outcome: "cleared" or "confirmed_fraud", note }` (all required) | `200 { received: true }` | 400 `invalid_request` / `invalid_outcome`, 401 `invalid_signature` | acquirer_callback_receipts, acquirer_callback_notes, transactions |

Signature checking is controlled by config (`acquirerCallbackRequireSignature`,
`acquirerCallbackSigningSecret`). In production the default is "required"; an
explicit `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false` can still turn it off, and
the audit recommends removing that opt-out (open decision). An empty secret no
longer accepts forgeable signatures, the signature is checked before field
validation, and deterministic 404s are not retried. The signature is computed
over the parsed JSON, not the raw bytes (confirm with the acquirer). Three
locked tests for this route fail only because they sign with a hard-coded 2025
timestamp that is outside the 300 s window.

### Outbound: FilsPay to the merchant's URL
There is no HTTP endpoint for this; it is a background job
(`webhooks/dispatcher.ts`). Public event types built by `webhooks/envelope.ts`:
`transaction.captured`, `transaction.voided`, `settlement.paid`.
Each request carries a `Webhook-Signature: t=<ts>,v1=<hmac-sha256>` header
(re-signed with a fresh timestamp on each attempt) and a `Webhook-Delivery-Id`
that is stable across retries of one delivery but **new for each replay**.
In production the sender resolves the receiver's host, rejects private
addresses (wider blocklist than before: 100.64/10, 192.0.0.0/24, 198.18.0.0/15,
NAT64, 6to4, Teredo, test nets, IPv6 parsed fully, fail closed) and pins the
connection to the vetted IPs using `node:http`/`https` (stops DNS rebinding).
Redirects are never followed. Fixed in code, covered by unit tests; the pinning
was not exercised against real public DNS. Defaults: up to 8 attempts, exponential
backoff from 30 s, capped at 6 h, +/-10 % jitter.
`settlement.batch_closed` goes to the outbox for the reporting worker but is
**not** a public webhook type. There is no `refund.succeeded` event, and it is
deliberately **not** in the dispatcher's eligible list (adding a type there
without an `envelope.ts` case would stall the whole queue).

---

## 10. Admin  (prefix `/v1/admin`)

Admin auth is separate from merchant auth: cookie `fp_admin_sid`, a different
table (`admin_sessions`), and `requireAdminSession` never reads merchant or
impersonation cookies. Role gates are checked on the server; hiding buttons in
the admin UI is not security.

"F/SA" below means roles `finance` or `super_admin`. "Any" means any admin role
(`support`, `finance`, `super_admin`).

### 10.1 Admin sign-in  (prefix `/v1/admin/auth`)

| Method + path | Auth | Purpose | Body | Response | Tables | Frontend |
|---|---|---|---|---|---|---|
| `POST /v1/admin/auth/login` | public | Email + password, creates pending session and OTP | `{ email, password }` | `200 { otpRequired: true, otpExpiresAt, devOtpCode? }` | admin_users, admin_otp_challenges, admin_sessions | admin `/login` |
| `POST /v1/admin/auth/otp/verify` | pending admin cookie | Promote session (default 8 h) | `{ code }` | `200 { authenticated: true, adminUserId, role }` | admin_otp_challenges, admin_sessions | admin `/login` |
| `GET /v1/admin/auth/me` | admin session | Current admin | - | `{ adminUserId, email, role }` | admin_sessions, admin_users | admin shell |
| `POST /v1/admin/auth/logout` | admin session | Revoke session | - | `204` | admin_sessions | admin header |

There is **no** admin `otp/resend` route (the merchant side has one).

### 10.2 Merchants (read and review)  (prefix `/v1/admin/merchants`)

| Method + path | Roles | Purpose | Body / params | Response | Tables | Frontend |
|---|---|---|---|---|---|---|
| `GET /v1/admin/merchants` | Any | Search all merchants (the one cross-merchant list) | query `q`, `onboardingStatus` (repeatable), `limit`, `cursor` | page | merchants and profile | `/merchants` |
| `GET /v1/admin/merchants/:id` | Any | Merchant detail | UUID | detail (404 `merchant_not_found` if not a UUID or unknown) | merchants, profile, balances... | `/merchants/:id` |
| `GET /v1/admin/merchants/:id/kyc/documents` | F/SA | List KYC documents | - | list | kyc_documents | merchant detail |
| `GET /v1/admin/merchants/:id/kyc/documents/:documentId/file` | F/SA | Download KYC file | - | bytes | kyc_documents | merchant detail |
| `POST /v1/admin/merchants/:id/kyc-reviews` | F/SA | Approve or reject KYC. Writes an audit row in the same transaction. There is no precondition on status or uploaded documents (open decision S-4); only bulk approve requires `under_review` | `{ outcome: "approved" or "rejected", notes? }` | `200` review result | merchant_kyc_reviews, merchants, admin_audit_log | merchant detail |
| `POST /v1/admin/merchants/bulk-approve` | F/SA | Approve many merchants under review (max 200 ids). Others come back in `skippedMerchantIds` | `{ merchantIds[], notes? }` | `200 { approvedMerchantIds, skippedMerchantIds, ... }` | merchants, merchant_kyc_reviews, admin_audit_log | merchant list |
| `POST /v1/admin/merchants/:id/api-keys/:keyId/rotate` | F/SA | Revoke one key and issue a new one atomically | `{ label? }` | `201 { id, prefix, rawKey, createdAt, previousKeyId }` | api_keys, admin_audit_log | merchant detail |
| `POST /v1/admin/merchants/:id/impersonate` | Any (including `support`; deciding who may start it is an open decision) | Start a "view as merchant" grant (default 15 min). Sets cookie `fp_impersonation` | - | `201 { grantId, merchantId, expiresAt }` | admin_impersonation_grants, admin_audit_log | merchant detail |
| `POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/replay-batch` | Any | Re-queue many deliveries in a time range | `{ from, to, statuses? }` ISO times, from < to | `200` summary | webhook_deliveries, admin_audit_log | `/webhooks/:merchantId` |
| `POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/archive` | Any | Archive deliveries in a range into `webhook_delivery_archives` | `{ from, to }` | `201` | webhook_delivery_archives | webhook replay |
| `POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/archive/:archiveId/replay` | Any | Replay an archive (optionally to another endpoint) | `{ targetEndpointId? }` | `200` | webhook_delivery_archives, webhook_deliveries | webhook replay |
| `POST /v1/admin/merchants/:id/transactions/recompute-statuses` | F/SA | Recompute transaction statuses for a merchant and reconcile the sandbox flag | - | `200 { scanned, updated, flagsUpdated }` | transactions, merchants, admin_audit_log | (no UI found) |
| `POST /v1/admin/merchants/:id/balance-adjustments` | F/SA | Add a signed delta to the payable balance. The route calls `adjustMerchantBalanceJournaled`: it posts **balanced ledger entries**, updates the `merchant_balances` cache and writes audit action `balance_adjustment_journaled`, all in one transaction, so the adjustment survives a balance rebuild. If the delta or the resulting balance is out of range it returns `400` (was 500). ADR-0006 describes the older cache-only behaviour; treat it as superseded here | `{ deltaFils (non-zero integer), reason }` | `200` before/after | merchant_balances, ledger_entries, admin_audit_log | merchant detail |
| `POST /v1/admin/merchants/:id/mdr-recalculation` | F/SA | Ask the Go service to recompute fees for `closed` batches in a date range and post adjustments | `{ from, to }` (`YYYY-MM-DD`) | `200` summary | settlement_batches, ledger_entries, admin_audit_log | `/settlement` |
| `POST /v1/admin/merchants/:id/credits` | F/SA | Create a credit request | body validated in `admin/credits.ts` | `201` | credit_requests | merchant detail / `/credits` |

Impersonation facts: it is read-only (merchant routes refuse writes). **Every
admin role now maps to merchant role `support`** (`admin/impersonation.ts`),
matching `HANDOVER.md` and `ADMIN.md`. Any admin role can still start a grant
(`CLAUDE.md`'s claim of a `super_admin` middleware check is false).

**Limitation (finding D-1, from reading the code, not run live):** "view as
merchant" does not work end to end. The merchant dashboard decides whether you
are signed in by calling `GET /v1/auth/me`, which uses `requireSession` and
accepts only a real merchant session cookie, not `fp_impersonation`. A
dashboard code comment also says impersonation does not exist in the merchant
plane. The dashboard would show its login page. Fixing it needs `/me` to accept
the grant plus UI work, and interacts with who may start impersonation.

### 10.3 Credits  (no extra prefix, under `/v1/admin`)

| Method + path | Roles | Purpose | Body | Response | Tables |
|---|---|---|---|---|---|
| `GET /v1/admin/credits` | Any | Credit request queue | query `status`, `merchantId`, `limit`, `cursor` | page | credit_requests |
| `POST /v1/admin/credits/:creditRequestId/approve` | F/SA | Approve a request; posts ledger entries and updates the balance. The approver must not be the same **admin user id** as the requester (409 `self_approval_forbidden`; display names are no longer compared). Ledger rows are dated at Bahrain midnight of the credit's effective date | - | `200` | credit_requests, ledger_entries, merchant_balances |
| `POST /v1/admin/credits/:creditRequestId/reject` | F/SA | Reject | `{ reason }` | `200` | credit_requests |

Frontend: `/credits`.

### 10.4 Adjustment CSV imports  (prefix `/v1/admin/adjustment-imports`)

| Method + path | Roles | Purpose | Body | Response | Tables |
|---|---|---|---|---|---|
| `POST /v1/admin/adjustment-imports` | F/SA | Upload and **immediately apply** a CSV of `merchantId,amount,reason` rows (amount in BD with up to 3 decimals, e.g. `4.750`). Duplicate content is rejected (content hash, migration 0073). A reason containing commas is now kept whole. There is no second approver, threshold or row cap (open decision S-5) | `{ csvContent, originalFilename? }` | `201` import result | adjustment_imports, adjustment_import_rows, merchant_balances |
| `GET /v1/admin/adjustment-imports` | Any | Import history | query `limit`, `cursor` | page | adjustment_imports |
| `GET /v1/admin/adjustment-imports/:id/rows` | Any | Rows of one import | UUID | `{ rows }` or 404 `adjustment_import_not_found` | adjustment_import_rows |

Frontend: `/adjustment-imports`.

### 10.5 Platform operations (directly under `/v1/admin`)

| Method + path | Roles | Purpose | Body | Response | Notes |
|---|---|---|---|---|---|
| `POST /v1/admin/settlement/run-batch` | F/SA | Ask the Go service to (re)close a business day, optionally for one merchant | `{ date: "YYYY-MM-DD", merchantId? }` | `200` summary with `merchantResults`; if any merchant fails, the Go service answers HTTP `500` with `run_batch_partial_failure` and a `failedMerchants` list (the other merchants were still settled), and the admin UI shows an error | Audit row is committed **before** the cross-process call, outcome updated after. Calls Go `POST /internal/run-batch` |
| `POST /v1/admin/balances/rebuild` | F/SA | Ask the Go service to rebuild cached balances | none | `200` summary | Go `POST /internal/rebuild-balances`; same audit pattern |
| `POST /v1/admin/reporting/rebuild` | F/SA | Rebuild analytics tables from the outbox, inside the API process, one transaction | none | `200 { volumeRows, trendRows }` | writes merchant_daily_volume, merchant_payout_trends |
| `POST /v1/admin/impersonation/:grantId/end` | Any | End an impersonation grant and clear the cookie | - | `204` | admin_impersonation_grants |

Frontend for the first three: `/settlement`.

---

## 11. Internal service (not part of the public API)

The Go settlement service listens on `SETTLEMENT_INTERNAL_PORT` (default 8091)
with bearer-token auth: `POST /internal/run-batch`,
`POST /internal/rebuild-balances`, `POST /internal/recalculate-mdr`. Only the
API's admin routes call these. In production both the API and the Go service
refuse the built-in `dev-token`. The Go internal API binds all network
interfaces (open item; keep the port private).

## 12. Production configuration guards (new in the audit)

`loadConfig` throws at startup when `NODE_ENV=production` and any of these
holds: `SETTLEMENT_INTERNAL_TOKEN` empty or `dev-token`; the built-in dev
webhook encryption key; `COOKIE_SECURE=false`; `OTP_DEV_EXPOSE=true`;
`DATABASE_URL` with `sslmode=disable` (opt out with `DATABASE_ALLOW_NO_TLS=true`
on a private network); empty `ACQUIRER_CALLBACK_SIGNING_SECRET`; non-HTTPS
`BROWSER_ORIGINS`. An unknown `NODE_ENV` value such as `prod` now throws instead
of silently becoming development. An **unset** `NODE_ENV` still means
development (finding S-19, open decision: staging reportedly runs that way).

## 13. Things to double check before relying on this page

- Table lists for routes that delegate to helper modules were taken from the
  handler plus the helper's SQL where it was read; treat them as the main
  tables, not a guaranteed complete list.
- The API-key, reporting and recompute endpoints have no obvious UI page in the
  two React apps.
