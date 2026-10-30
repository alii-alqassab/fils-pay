# FilsPay architecture diagrams

Mermaid diagrams drawn from the current source (refreshed 2026-10-30, after the
audit fixes). Money is integer fils (1 BD = 1000 fils). Settlement days follow
Asia/Bahrain time. Hand-checked, not rendered. Nothing here was exercised in a
live browser.

---

## 1. System architecture

```mermaid
flowchart LR
  subgraph Browsers
    W["Merchant web + checkout<br/>apps/web :5173"]
    A["Admin console<br/>apps/admin :5174"]
  end
  S["Merchant server<br/>(API key)"]
  ACQ["Acquirer<br/>(simulator in code)"]
  MR["Merchant webhook receiver"]

  subgraph FilsPay
    API["apps/api (Fastify) :3000<br/>REST + webhook dispatcher"]
    SET["apps/settlement (Go)<br/>daemon + internal HTTP :8091"]
    REP["apps/reporting<br/>outbox consumer"]
    DB[("PostgreSQL 16<br/>ledger, outbox, ...")]
  end

  W -->|cookie fp_sid| API
  A -->|cookie fp_admin_sid| API
  S -->|Bearer API key| API
  ACQ -->|signed callback| API
  API -->|authorize / capture| ACQ
  API <--> DB
  API -->|"bearer token, admin actions"| SET
  SET <--> DB
  REP <--> DB
  API -->|signed webhook| MR
  DB -. "NOTIFY outbox_events_channel" .-> API
  DB -. "NOTIFY / poll" .-> REP
```

The services share one database. The API never computes settlement; it asks the
Go service over HTTP. Inside the API, one app-level hook applies in-memory rate
limits (login, OTP, admin login, public pay, signup) before the route handlers
run; behind a load balancer set `TRUST_PROXY` so client IPs are correct.

---

## 2. Customer payment flow (payment link)

```mermaid
sequenceDiagram
  participant C as Customer browser /pay/token
  participant API as apps/api
  participant ACQ as Acquirer simulator
  participant DB as Postgres

  C->>API: GET /v1/payment-links/:token
  API->>DB: read payment_links
  API-->>C: amount, description, status
  C->>API: POST /v1/payment-links/:token/pay (Idempotency-Key, card)
  API->>DB: UPDATE payment_links SET status=reserved (atomic claim)
  API->>ACQ: authorize
  alt declined or error
    API->>DB: release reservation
    API-->>C: 402 / 502
  else approved
    API->>DB: INSERT transactions(authorized), holds, transaction_events
    API->>ACQ: capture
    API->>DB: UPDATE transactions(captured), INSERT ledger_entries (gross + fee)
    API->>DB: INSERT outbox_events(transaction.captured)
    API->>DB: UPDATE payment_links SET status=paid
    API-->>C: result
  end
```

Direct API-key flow is the same without the link: `POST /v1/transactions`
(authorize, 201) then `POST /v1/transactions/:id/capture`, or `.../void`.

---

## 3. Merchant workflow

```mermaid
flowchart TD
  R["Register<br/>POST /v1/merchants"] --> L["Login (password) then OTP<br/>/v1/auth/email-login, /otp/verify"]
  L --> O["Onboarding: business profile + KYC documents"]
  O --> RV{"Admin KYC review<br/>onboarding_status"}
  RV -- rejected --> O
  RV -- approved --> K["Create API key (owner)"]
  RV -- approved --> PL["Create payment links"]
  RV -- approved --> WH["Register webhook endpoint"]
  K --> PAY["Take payments<br/>authorize / capture / void"]
  PL --> PAY
  PAY --> TX["View transactions + events + CSV export"]
  PAY --> ST["Daily settlement batch"]
  ST --> RC["Settlement list + reconciliation + overview analytics"]
  PAY -. "outbox" .-> WH
```

Only merchants with `onboarding_status = approved` and `status = active` can
authorize payments.

---

## 4. Settlement workflow

```mermaid
flowchart TD
  T["Daemon wakes (poll every 60 s)<br/>due 15 min after Asia/Bahrain midnight<br/>(about 00:15 Bahrain; BusinessDayStartAt)"] --> CB
  AD["Admin: POST /v1/admin/settlement/run-batch"] -->|"audit row first, then HTTP"| CB
  CB["CloseBatch (per merchant, one DB transaction)"]
  CB --> LK["Lock batch row (merchant, date)<br/>UNIQUE merchant_id + batch_date"]
  LK --> SEL["Select capture events<br/>settlement_batch_id IS NULL<br/>inside the Bahrain day window"]
  SEL --> FEE["Fee per event: schedule rate - volume bonus,<br/>discount applied; sum gross, fee, net"]
  FEE --> FRZ["Batch -> closed, events stamped with batch id"]
  FRZ --> SCH["scheme_export_lines: amount cut to multiple of 10 fils<br/>residue -> scheme_rounding_residue / card_scheme_clearing"]
  SCH --> OB["outbox: settlement.batch_closed"]
  OB --> BAL["Update merchant_balances cache"]
  BAL --> PB["PayoutBatch: debit merchant_payable,<br/>credit platform_cash (net)"]
  PB --> PD["Batch -> paid, disbursement recorded"]
  PD --> NT["outbox: settlement.paid -> webhook + reporting"]
```

Re-running a closed or paid day is a no-op. Zero-activity days still produce a
closed batch with zeros. `RunDailyBatch` handles each merchant on its own: a
failing merchant is logged and skipped, the others are still closed and paid, and
a `BatchFailuresError` listing the failed merchants is returned at the end (the
CLI exits non-zero; the internal API answers HTTP 500 `run_batch_partial_failure`).
The daemon logs a partial failure and still calls `EnqueuePayoutNotifications` on
that tick, so `settlement.paid` events for the merchants that were paid are not held
back by one failing merchant (fixed during the audit; covered by the Go build and
suite, not exercised end to end).

Worked numbers: capture 10000 fils at 250 bps -> fee 250, net 9750.

---

## 5. Refund workflow (current state)

```mermaid
flowchart TD
  U["No Refund button exists<br/>RefundDrawer.tsx is fully commented out"] -. "the old drawer code posted to /v1/merchants/:id/refunds (no such route)" .-> R["POST /v1/refunds"]
  R --> AU{"requireMerchantAuth"}
  AU -- fails --> E401["401"]
  AU -- ok --> S501["501 not_implemented<br/>(no logic)"]

  subgraph Exists but is not called by any route
    H1["refunds/initiateMerchantRefund.ts<br/>(expects /v1/merchants/:id/refunds)"]
    H2["payments/processRefund.ts + refundValidation.ts + refundState.ts"]
    H3["refunds table, calculateRefundFee in packages/money"]
    H1 --> H2 --> H3
  end
```

Nothing writes to `refunds` today. No `refund.*` webhook event exists. Project
rules say keep the 501 stub until the refund work is decided (FP-212). The
`RefundDrawer.tsx` is entirely commented out (`export {}`), so the dashed
arrow is only history. The helper `processRefund.ts` was fixed (blank reason becomes
`unspecified`, ownership check inside the helper) but still has no caller.

---

## 6. Webhook delivery

```mermaid
sequenceDiagram
  participant W as Write (capture, void, payout)
  participant DB as outbox_events
  participant D as Dispatcher (in apps/api)
  participant WD as webhook_deliveries
  participant R as Merchant receiver

  W->>DB: INSERT outbox row in same transaction
  DB-->>D: NOTIFY outbox_events_channel (plus periodic poll)
  D->>WD: create one pending delivery per active endpoint (event types: captured, voided, settlement.paid)
  loop due deliveries (claimed so only one worker sends)
    D->>R: POST payload + Webhook-Signature: t=..,v1=HMAC-SHA256 + Webhook-Delivery-Id (production: host vetted, connection pinned to vetted IPs)
    alt 2xx
      D->>WD: status = succeeded
    else failure
      D->>WD: attempt_count + 1, next_attempt_at = backoff (30 s doubling, cap 6 h, +/-10%)
      Note over D,WD: after 8 attempts status = exhausted
    end
  end
  Note over R: Merchant can replay a delivery (202) or admin can batch / archive replay
```

Test sends (`POST .../webhook-endpoints/:id/test`) skip the queue and are sent
synchronously. A replay creates a new delivery row with a new delivery id. The
delivery status `failed` is never set (only `pending`, `succeeded`, `exhausted`).
Deleted (soft-deleted) endpoints return 404 on test-send and detail.

---

## 7. Authentication and authorization

### 7.1 Merchant session + OTP

```mermaid
sequenceDiagram
  participant B as Browser
  participant API as apps/api
  participant DB as Postgres
  B->>API: POST /v1/auth/email-login {email, password}
  API->>DB: verify argon2 hash, create otp_challenge + pending session
  API-->>B: Set-Cookie fp_sid (pending, 10 min) + otpRequired (dev: devOtpCode)
  B->>API: POST /v1/auth/otp/verify {code}
  API->>DB: check attempts (max 5), mark consumed, promote session (12 h)
  API-->>B: authenticated + role, cookie lifetime extended (new token if ROTATE_SESSION_ON_OTP_VERIFY)
  B->>API: GET /v1/transactions (cookie)
  API->>DB: lookup session by hash of token
  API-->>B: data scoped to session's merchant
```

A pending session authenticates nothing. Resend is limited to once per 30 s and
carries over failed attempts; exhausting the attempts revokes the session. The
OTP code is drawn with `crypto.randomInt`. With `ROTATE_SESSION_ON_OTP_VERIFY`
on (default in production only), verify replaces the pending token with a new
one so a cookie copied during the OTP step is useless afterwards (session
fixation fix; the same for admin sessions).

### 7.2 Which credential reaches which route

```mermaid
flowchart TD
  REQ["Merchant-area request"] --> M{"requireMerchantAuth"}
  M -->|"1. cookie fp_sid valid"| SES["actor = merchant_session (role owner/finance/support)"]
  M -->|"2. Bearer API key valid"| KEY["actor = merchant_api_key (no role)"]
  M -->|"3. cookie fp_impersonation valid"| IMP["actor = admin_impersonation<br/>GET / HEAD / OPTIONS only"]
  M -->|none| U401["401 unauthenticated"]
  SES --> RR{"requireMerchantRole(...)"}
  KEY -->|"always allowed"| OK["handler"]
  IMP --> RR
  RR -- role listed --> OK
  RR -- not listed --> F403["403 forbidden"]
  OK --> W{"write?"}
  W -- "impersonation write" --> F403
```

Authorize (`POST /v1/transactions`) is **API key only**. Auth, KYC, profile and
API-key routes use the older `requireSession` (session only). Capture and void
now use `requireMerchantRole("owner", "finance")`, so a `support` session gets
403 while an API key still passes. The merchant dashboard's `GET /v1/auth/me`
uses `requireSession`, which is why the impersonation cookie does not get the
dashboard past its login gate (finding D-1).

### 7.3 Admin roles and impersonation

```mermaid
flowchart TD
  AL["POST /v1/admin/auth/login"] --> AO["POST /v1/admin/auth/otp/verify"]
  AO --> AS["cookie fp_admin_sid (8 h)"]
  AS --> RS{"requireAdminSession<br/>(re-reads admin status)"}
  RS --> ANY["Any role: lists, detail, history,<br/>impersonate, webhook replay/archive"]
  RS --> RF{"requireAdminRole(finance, super_admin)"}
  RF --> FIN["KYC review, bulk approve, key rotate,<br/>balance adjust, CSV import, credits approve,<br/>run-batch, rebuild balances/reporting, MDR recalculation"]
  RS --> SUP["support: blocked from FIN routes (403)"]
  ANY --> IMPS["POST /v1/admin/merchants/:id/impersonate"]
  IMPS --> CK["cookie fp_impersonation (15 min)<br/>every admin role -> merchant role support<br/>writes refused"]
  CK -. "GET /v1/auth/me only accepts a real merchant session (D-1)" .-> DEAD["merchant dashboard shows its login page:<br/>view as merchant does not work end to end"]
  CK --> END["POST /v1/admin/impersonation/:grantId/end"]
  FIN --> AUD["admin_audit_log row"]
```

`requireAdminSession` never reads the merchant or impersonation cookies, so an
impersonation grant gives no admin power.

### 7.4 Acquirer callback

```mermaid
flowchart LR
  ACQ["Acquirer"] -->|"POST /v1/acquirer/callbacks<br/>Acquirer-Callback-Signature: t=..,v1=.."| V{"signature valid?<br/>(per config)"}
  V -- no --> E["401 invalid_signature"]
  V -- yes --> AP["apply fraud_review.completed<br/>(cleared / confirmed_fraud), deduped by callbackId"]
  AP --> OK["200 received:true"]
```
