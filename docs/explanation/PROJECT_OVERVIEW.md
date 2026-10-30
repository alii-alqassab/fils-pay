# FilsPay project overview

Plain-English tour for a new programmer. Refreshed on 2026-10-30 after the
audit fixes, from the current source. If this page disagrees with `CLAUDE.md`
or `AGENTS.md`, this page (and the code) wins on two points: money is **fils**
(1 BD = 1000 fils, not cents) and the settlement day follows **Asia/Bahrain**
time (not UTC). Details are in `docs/audit/CURRENT_PROJECT_STATUS.md`.

Status words: "fixed in code, covered by unit tests, not exercised in a live
browser" means an audit agent changed the code and a test checks it, but nobody
clicked through it. Nothing in this folder was verified in a browser.

---

## 1. The idea

FilsPay is a payment gateway sketch for Bahrain:

1. A **merchant** (a shop) signs up and gets verified (KYC).
2. A **customer** pays by card, through a payment link or through the
   merchant's own server.
3. FilsPay talks to a card **acquirer** (simulated here) and records the money in
   a **double-entry ledger**.
4. Each night a **settlement** job adds up the day, takes the fee (MDR), and
   marks what to pay out.
5. The merchant sees everything in a **dashboard**; staff use an **admin
   console**.

No real money or cards are involved anywhere in this repo.

## 2. Words you need

| Word | Meaning |
|---|---|
| fils | 1/1000 of a BD. All money is an integer number of fils |
| BHD / BD | Bahraini Dinar |
| MDR | Merchant discount rate: the fee. Stored in basis points (250 = 2.50 %) |
| authorize | Reserve the customer's money (creates a *hold*) |
| capture | Actually take it (writes ledger entries, takes the fee) |
| void | Cancel an authorization |
| settlement batch | One merchant's captures for one business day, summed |
| outbox | A table of "something happened" events written together with the change |
| webhook | A signed HTTP call from FilsPay to a merchant's server |
| KYC | Know-your-customer documents reviewed by staff |
| OTP | One-time code used as a second login step |
| idempotency key | A caller-chosen id that makes a repeated request safe |

## 3. Components

```
 apps/web  (:5173)    merchant dashboard + /pay/:token checkout   React/Vite
 apps/admin (:5174)   staff console                               React/Vite
 apps/api  (:3000)    REST API + webhook dispatcher               TypeScript/Fastify
 apps/settlement      daily close, fees, payouts, scheme file     Go  (internal :8091)
 apps/reporting       builds dashboard numbers from the outbox    TypeScript
 packages/money       Fils type, rounding, parsing   (FROZEN)
 packages/events      outbox helper
 db/                  migrations (SQL) + seed data
 ops/                 docker-compose for Postgres and services
```

All services share one PostgreSQL database. They talk through tables (the
outbox plus `LISTEN/NOTIFY`) and one small authenticated internal HTTP API on
the Go service. Diagrams: `ARCHITECTURE_DIAGRAMS.md`.

## 4. Life of a payment in five lines

1. `POST /v1/transactions` (API key) authorizes: a `transactions` row and a
   `holds` row appear.
2. `POST /v1/transactions/:id/capture` takes the money: four `ledger_entries`
   rows (gross in, fee out), an `outbox_events` row.
3. The reporting worker turns the outbox row into daily numbers; the webhook
   dispatcher sends `transaction.captured` to the merchant.
4. After Bahrain midnight (the daemon starts about 00:15 Bahrain) the Go
   service closes the batch: gross, fee, net.
5. The batch is paid: `merchant_payable` debited, `platform_cash` credited, and a
   `settlement.paid` event goes out.

Example: 10.000 BD at 2.50 % -> gross 10000 fils, fee 250, merchant gets 9750.

## 5. Who can do what

Merchant users: `owner` (everything, including API keys), `finance`
(payment links, webhooks, reconciliation, **capture and void**), `support`
(read mostly). Capture and void now need role `owner` or `finance` for a
signed-in user (session). API keys act as the merchant: they pass every role
check (a known open risk, finding S-8).

Admin users: `support` (read, impersonate, webhook replay), `finance` and
`super_admin` (money-affecting actions: KYC review, settlement runs,
adjustments, credits).

Staff can "view as merchant" for 15 minutes. The grant is read-only and every
admin role maps to merchant role `support`. Any admin role can still start it.
**Important limitation (finding D-1, found by reading code, not run live):**
"view as merchant" does not work end to end. The merchant dashboard checks login
with `GET /v1/auth/me`, which accepts only a real merchant session, not the
impersonation cookie, so the dashboard would show its login page.

## 6. What works and what does not

Working (implemented and wired; tested by unit tests, not clicked through in a
browser): signup/login with OTP, KYC upload and review, API keys, authorize /
capture / void, payment links and public checkout, webhooks (send, log, replay),
settlement batches and reconciliation, analytics, admin console.

Not working: **refunds** (`POST /v1/refunds` still returns 501; the helper code
in `payments/processRefund.ts` was fixed but no route calls it, and
`RefundDrawer.tsx` is fully commented out). Missing from the repo:
`run-local.sh`. Full list: `docs/audit/CURRENT_PROJECT_STATUS.md`.

## 7. What the audit changed (short)

- Admin "Adjust balance" now posts balanced ledger entries as well as updating
  the cache, so it survives a balance rebuild (audit action
  `balance_adjustment_journaled`).
- OTP codes, payment-link slugs and display references use `crypto.randomInt`.
- Rate limiting (429 `rate_limited`) on login, OTP, admin login, public pay and
  signup. Off in `NODE_ENV=test` unless `RATE_LIMIT_ENABLED=true`.
- Production config refuses unsafe settings (dev token, dev webhook key,
  non-secure cookies, OTP exposure, no-TLS database, unknown `NODE_ENV`).
- Settlement daemon closes the right Bahrain day about 00:15 Bahrain time; one
  failing merchant no longer blocks the others.
- Capture and void role gates, amount bounds, 400/404 instead of 500 for bad
  input, public payment-link response no longer leaks the API key hash, webhook
  SSRF guard, KYC filename safety, saved-filter cap.

Open decisions and the 13 API tests that still fail (they contradict the code and
cannot be edited): `docs/audit/AGENT_TASKS.md`, `docs/audit/DISCOVERY_FINDINGS.md`.

## 8. Project rules a newcomer must know

- Do not edit `packages/money` or `apps/settlement/internal/money` (frozen).
- Do not edit existing test files; add new `*.new.test.ts` / `*_new_test.go`.
- Use `parseBhdToFils` for text amounts. Never use floats for money.
- Test on a scratch database, never the main `filspay` one.
- Treat `docs/ARCHITECTURE.md` and the code as more reliable than `CLAUDE.md` /
  `AGENTS.md`, which contain mistakes (cents vs fils, UTC vs Bahrain,
  `Math.random` for OTPs, impersonation gate, INTEGER columns).

## 9. Read in this order

1. `BEGINNER_GUIDE.md` to start the project.
2. `ARCHITECTURE_DIAGRAMS.md` for the pictures.
3. `API_EXPLAINED.md` for every endpoint.
4. `DATABASE_EXPLAINED.md` for tables and the ledger.
5. `docs/adr/` for why things are the way they are.
6. `SEND_TO_CHATGPT.md` for one self-contained explanation of everything.
