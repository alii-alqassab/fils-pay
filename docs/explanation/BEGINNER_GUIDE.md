# FilsPay beginner guide

For someone who has just opened this repo. Simple steps, honest limits.
Refreshed on 2026-10-30 after the audit fixes, checked against the source. I did
not start any service while writing this; commands below are what the repo files
say, not output I ran. "Fixed in code, covered by unit tests, not exercised in a
live browser" means a fix exists and a test checks it, but nobody clicked
through it.

---

## 1. What is FilsPay?

A small **payment gateway** for Bahrain. A shop (the *merchant*) takes card
payments, FilsPay keeps a ledger of who is owed what, and once a day it adds
up the money and prepares a payout.

- Currency: Bahraini Dinar (BD / BHD).
- **1 BD = 1000 fils.** All money in code and database is an integer count of
  fils. 10.000 BD is `10000`. Never use decimals or floats for money.
- The "acquirer" (the card network) is **simulated** in code. No real card is
  charged anywhere in this repo.

Parts:

| Folder | What it is | Language |
|---|---|---|
| `apps/api` | The HTTP API (Fastify). Port 3000 | TypeScript |
| `apps/web` | Merchant dashboard + customer checkout page. Port 5173 | React + Vite |
| `apps/admin` | Staff admin console. Port 5174 | React + Vite |
| `apps/settlement` | Daily batch close, fees, payouts. Internal port 8091 | Go |
| `apps/reporting` | Builds dashboard numbers from events | TypeScript |
| `packages/money` | Money maths. **Frozen: do not edit** | TypeScript |
| `packages/events` | The "outbox" helper for events | TypeScript |
| `db/` | Migrations (`db/migrations`), seed data (`db/seed`) | SQL / TS |
| `docs/` | Docs (some are out of date, see `docs/audit/CURRENT_PROJECT_STATUS.md`) | |

---

## 2. Getting it running

### What `LOCAL-README.md` says
It tells you to run `npm install` then `./run-local.sh`, which should start
Postgres in Docker, run migrations, and launch the API, reporting worker,
settlement daemon, merchant web and admin app.

### Important: `run-local.sh` is not in this checkout
I looked again (`ls run-local.sh` fails): there is **no** `run-local.sh`
anywhere in the repo. `LOCAL-README.md` is stale in three more ways: it says the
Dockerfiles are missing (`ops/Dockerfile.node` and `ops/Dockerfile.go` exist), it
says the seed "resets its fixture tables" (it now inserts into an empty database
only, see "Demo data"), and it does not mention `SEED_RESET=1`. Until someone
adds the script, start the pieces yourself.

### Manual start (based on the files in the repo)
Requirements: Docker, Node.js + npm, Go.

1. Install packages: `npm install`
2. Start only Postgres: `docker compose -f ops/docker-compose.yml up postgres`
   (user `filspay`, password `filspay_dev_password`, database `filspay`, port 5432).
3. Apply the schema (new terminal, repo root):
   ```bash
   DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable' npm run migrate
   ```
4. Start the API: `npm run dev --workspace @filspay/api`
   (script is `tsx src/index.ts`). It needs the same `DATABASE_URL`, and
   `WEBHOOK_SECRET_ENCRYPTION_KEY` (a base64 32-byte key; `LOCAL-README.md` shows a
   local one that is all `A`s). Defaults: port 3000, dev OTP exposed. To let the
   admin console reach a settlement daemon on your host, also set
   `SETTLEMENT_INTERNAL_URL=http://localhost:8091` (the default is the compose
   name `http://settlement:8091`) and the same `SETTLEMENT_INTERNAL_TOKEN` as the
   daemon. If you leave `NODE_ENV` unset it means development. Rate limiting is
   ON by default outside tests (429 `rate_limited` after 10 logins per minute per
   IP and email); raise the `RATE_LIMIT_*` variables if you script many logins.
5. Reporting worker: `npm run dev --workspace @filspay/reporting`
6. Settlement daemon (optional for first look): in `apps/settlement` run the Go
   binary with the `daemon` argument (see `cmd/settlement/main.go`; other
   commands are `run-batch --date=YYYY-MM-DD [--merchant=<uuid>]`,
   `rebuild-balances`, `export-scheme-file`). The daemon needs `DATABASE_URL` and
   `SETTLEMENT_INTERNAL_TOKEN` (not `dev-token` in production). It checks every
   60 seconds and closes yesterday's Bahrain business day about 15 minutes after
   Bahrain midnight.
7. Merchant web: `npm run dev --workspace @filspay/web`  -> http://localhost:5173
8. Admin: `npm run dev --workspace @filspay/admin` -> http://localhost:5174

If a workspace name differs, check the `name` field in that app's
`package.json`.

The simplest alternative is `docker compose -f ops/docker-compose.yml up`, which
the compose file says starts Postgres, runs migrate/seed jobs, and runs api,
settlement and reporting (not the two React apps). I have not tried it.

### Ports

| Thing | Port |
|---|---|
| API | 3000 |
| Merchant web | 5173 |
| Admin web | 5174 |
| Postgres | 5432 |
| Settlement internal HTTP (API calls it, not you) | 8091 |

Quick checks: open `http://localhost:3000/healthz` (should say `ok`) and
`http://localhost:3000/readyz`.

### Demo data
From `LOCAL-README.md` (local-only, synthetic):

```bash
DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable' \
NODE_ENV=development \
WEBHOOK_SECRET_ENCRYPTION_KEY='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' \
npm run seed
```

What the seed does now (fixed in the audit; the agent ran it on its own scratch
database, I did not):

- It refuses unless `NODE_ENV=development` (or `SEED_ALLOW=1`) and the database
  host is local (`localhost`, `127.0.0.1`, `::1`, or the compose service
  `postgres`).
- It inserts into an **empty** database only. On a database that already has data
  it stops. `SEED_RESET=1` **drops and recreates the whole `public` schema** and
  re-runs migrations, destroying everything in that database. Before the fix the
  seed failed on every database because the ledger is append-only.

---

## 3. Demo accounts (LOCAL ONLY)

These are written in `LOCAL-README.md` for local demo data. Never use them
anywhere real.

Merchant app (http://localhost:5173/dashboard/login):

- Email `owner@alpharetail.example`
- Password `FilsPaySeed!2026` (all seeded merchant users share it)
- Then an OTP step. In dev the code is **shown on screen / returned in the
  response as `devOtpCode`**.

Admin app (http://localhost:5174/login), password `FilsPayAdminSeed!2026`:

| Email | Role |
|---|---|
| `support@filspay.test` | support (read-mostly) |
| `finance@filspay.test` | finance |
| `superadmin@filspay.test` | super_admin |

Try the roles: support cannot approve KYC or run settlement; finance and
super_admin can.

---

## 4. How a payment works (the big picture)

```
Customer pays  ->  AUTHORIZE (reserve money)  ->  CAPTURE (take money)
                                         \-> VOID (cancel reservation)
Ledger entries are written at CAPTURE.
Every night (Bahrain time) the Go service groups captures into a SETTLEMENT BATCH,
then the batch is PAID OUT.
```

Ways to start a payment:
1. A **server (API key)** calls `POST /v1/transactions` then `/capture`.
2. A **payment link**: the merchant creates a link, the customer opens
   `/pay/<token>` and pays; the API authorizes and captures in one go.

---

## 5. Create a test payment

### Option A: via a payment link (easiest, uses the UI)
1. Sign in as `owner@alpharetail.example`.
2. Go to `/dashboard/payment-links/new`, enter an amount and an expiry.
3. Open the link it shows (`/pay/<token>`) in a private window.
4. Enter any simulated card details and pay. A card number ending in `0002`
   is always declined (`do_not_honor`), `0119` is declined
   (`insufficient_funds`), `0069` gives an acquirer error. Other cards are
   approved (about 2 % random failure by default). The checkout no longer sends
   the browser clock; the server clock decides expiry. The Pay button ignores a
   second click while the first request is running. Limit: 20 pay attempts per
   minute per IP and link.
5. Go to `/dashboard/transactions` and find the payment.

### Option B: with an API key and curl
1. Create an API key (owner only): `POST /v1/merchants/<merchantId>/api-keys`
   while signed in (the key is shown once). The web app has no page for keys
   that I could find, so use the API (with the session cookie).
2. Authorize 10.000 BD:
   ```bash
   curl -s -X POST http://localhost:3000/v1/transactions \
     -H "Authorization: Bearer <YOUR_API_KEY>" \
     -H "Idempotency-Key: demo-auth-001" \
     -H "Content-Type: application/json" \
     -d '{"amountFils":10000,"card":{"pan":"4111111111111111","expiryMonth":12,"expiryYear":2030,"cvv":"123"},"reference":"order-1"}'
   ```
3. Capture it (use the `id` from the response):
   ```bash
   curl -s -X POST http://localhost:3000/v1/transactions/<ID>/capture \
     -H "Authorization: Bearer <YOUR_API_KEY>" \
     -H "Idempotency-Key: demo-capture-001" \
     -H "Content-Type: application/json" -d '{}'
   ```
   Running the same command again returns the same answer (idempotency). A new
   key with the same transaction gives `409 not_capturable`.

Merchant must be `approved` and `active` to authorize, or you get `403`.
`amountFils` must be a whole number from 1 up to 99,999,999,990, else `400`
(`invalid_amount` or `amount_too_large`). Capture and void by a signed-in user
need role `owner` or `finance` (a `support` user gets `403`); an API key passes.

---

## 6. Inspect a transaction

In the UI: `/dashboard/transactions/<id>` shows status, amounts and the event
trail. Via API: `GET /v1/transactions/<id>` and `GET /v1/transactions/<id>/events`.

In the database (use psql against your local DB):

```sql
SELECT id, status, amount_fils, captured_fils FROM transactions ORDER BY created_at DESC LIMIT 5;
SELECT account_id, direction, amount_fils, description FROM ledger_entries WHERE transaction_id = '<ID>';
SELECT event_type, amount_fils, metadata FROM transaction_events WHERE transaction_id = '<ID>';
```

For a 10.000 BD capture at the default 2.50 %, expect four ledger rows: gross
10000 (debit `card_scheme_clearing`, credit `merchant_payable`) and fee 250
(debit `merchant_payable`, credit `platform_fee_revenue`). Full explanation in
`DATABASE_EXPLAINED.md`.

---

## 7. Refunds (honest status)

**Refunds do not work through the API.** `POST /v1/refunds` still answers
`501 {"error":"not_implemented"}` (it only checks you are signed in). The
helper code and the `refunds` table exist (the helper was fixed in the audit: a
blank reason becomes `unspecified`, and it checks the merchant owns the
transaction), but no route calls it. `RefundDrawer.tsx` is entirely commented
out, so there is no refund button. Repo rules say the stub must stay as is
until the refund design decisions are made (see `AGENT_TASKS.md`, REFUND-1).

---

## 8. Settlement

Settlement turns the day's captures into a payout.

- Done by the **Go service** (`apps/settlement`). It runs a daemon that closes
  "yesterday" shortly after midnight **Asia/Bahrain** (default 15 minutes after,
  so about 00:15 Bahrain time; before the audit fix the real close landed near
  03:00 because the run delay was ignored). If one merchant's close fails, the
  daemon still settles the others and logs the failure; a permanently failing
  merchant is retried every poll with no alert.
- A batch has three states: `open` -> `closed` -> `paid`.
- Each capture event is charged its fee, summed into `gross`, `fee`, `net`.
  For the 10.000 BD example: gross 10000, fee 250, net 9750 fils.
- Scheme file amounts are cut to 2 decimals; the leftover fils go to a residue
  account (see `DATABASE_EXPLAINED.md`).

See it: merchant app `/dashboard/settlement` and `/dashboard/reconciliation`;
API `GET /v1/settlement/batches`.

Trigger it by hand (admin finance / super_admin): admin app `/settlement` ->
run batch for a date; this calls `POST /v1/admin/settlement/run-batch`, which
asks the Go service. The Go service must be running, or you get a
connection error. If any merchant fails, the Go service answers HTTP 500
`run_batch_partial_failure` with a `failedMerchants` list; the other merchants
were still settled, but the admin page shows an error.

Important: `CLAUDE.md` and `AGENTS.md` say settlement days use UTC midnight
and amounts are cents. **Both are wrong.** The code uses Asia/Bahrain and fils.

---

## 9. Admin panel

http://localhost:5174. Pages:

| Page | Use |
|---|---|
| `/merchants`, `/merchants/:id` | Find merchants, review KYC, rotate API keys, adjust balance (now journaled to the ledger), view as merchant (impersonate; see the limitation below) |
| `/credits` | Credit requests: create, approve, reject |
| `/settlement` | Run a settlement day, rebuild balances, rebuild reporting, recalculate MDR |
| `/adjustment-imports` | Upload a CSV of balance adjustments (applies immediately) |
| `/webhooks`, `/webhooks/:merchantId` | Replay or archive webhook deliveries |

Rules: separate login and cookie from merchants; every sensitive action writes
a row in `admin_audit_log`; "view as merchant" is read-only, lasts 15 minutes,
and every admin role acts as merchant role `support`. **It does not work end to
end** (finding D-1, from reading the code, not run live): the merchant dashboard
calls `GET /v1/auth/me`, which accepts only a real merchant session, so the
dashboard shows its login page. Any admin role, even `support`, can still start a
grant.

---

## 10. Code map (where to look)

| I want to understand... | Open |
|---|---|
| Which URLs exist | `apps/api/src/app.ts`, then `apps/api/src/routes/*.ts` |
| Authorize / capture / void | `apps/api/src/payments/` |
| Payment links | `apps/api/src/paymentLinks/` |
| Login, OTP, sessions | `apps/api/src/auth/` (merchant), `adminAuth/` (admin) |
| API keys | `apps/api/src/apiKeys/` |
| Webhooks sending | `apps/api/src/webhooks/` (`dispatcher.ts`, `sign.ts`) |
| Fee rates | `apps/api/src/fees/` and `apps/settlement/internal/settlement/fee_schedule.go` |
| Daily close | `apps/settlement/internal/settlement/batch.go` |
| Business-day window | `apps/settlement/internal/settlement/window.go` |
| Dashboard numbers | `apps/reporting/src/consumer/applyEvent.ts` |
| Money maths | `packages/money/src/fils.ts` (read only) |
| Table definitions | `db/migrations/` |
| Merchant UI pages | `apps/web/src/pages/`, routes in `apps/web/src/router.tsx` |
| Admin UI pages | `apps/admin/src/pages/` |
| Decisions | `docs/adr/` |

Rules of the repo to remember: `packages/money` and
`apps/settlement/internal/money` are frozen; do not edit existing test files
(add new `*.new.test.ts` files); never touch the real `filspay` DB when testing,
use a scratch database.

---

## 11. Common errors

| What you see | Likely cause | Fix |
|---|---|---|
| `401 unauthenticated` | No/expired cookie, or pending session not yet OTP-verified | Sign in again and finish the OTP step |
| `403 forbidden` | Wrong role, merchant id in URL differs from yours, or you are impersonating and tried a write | Use the right account |
| `400 idempotency_key_required` | Missing `Idempotency-Key` header on authorize/capture/pay | Add a unique header |
| `422 idempotency_key_reused` | Same key with a different body | Use a new key |
| `409 not_capturable` | Already captured, voided, or not authorized | Look at `status` in the response |
| `422 capture_exceeds_remaining` | Capture amount bigger than what is left | Use `remainingFils` from the response |
| `402 card_declined` | Simulated decline (card ending 0002 / 0119, or random) | Use another card |
| `403` on authorize | Merchant not `approved` or not `active` | Approve KYC in admin |
| `501 not_implemented` | You called `POST /v1/refunds` | Refunds are not built |
| `503 not_ready` on `/readyz` | API never connected to the DB at boot | Fix `DATABASE_URL`, restart API |
| `429 resend_too_soon` | OTP resend inside 30 s | Wait |
| `429 rate_limited` (with `Retry-After`) | Too many logins, OTP tries, pay attempts or signups from one IP | Wait, or raise the `RATE_LIMIT_*` env values for local scripts |
| `403` on capture or void | Signed in as `support` (needs owner or finance) | Use an owner/finance user, or an API key |
| Login works but cookie "lost" after OTP in a test | `ROTATE_SESSION_ON_OTP_VERIFY` is on (default only in production) so the cookie changes at verify | Use the cookie from the verify response |
| Dashboard charts empty | Reporting worker not running or no events yet | Start `apps/reporting`; or admin "Rebuild reporting" |
| Admin run-batch fails | Go settlement service not running or wrong token | Start it; check `SETTLEMENT_INTERNAL_URL` / token |
| Migration error on `0054`/`0055` | Old copies of those files | Pull the version in this checkout (they were fixed) |
| API will not start about encryption key | `WEBHOOK_SECRET_ENCRYPTION_KEY` not 32 bytes (base64) | Use the key from `LOCAL-README.md` for local |

---

## 12. Running tests (read first)

- `CLAUDE.md` says to run the full suite after every file change. Running the
  API tests needs a database, so use a **scratch** database and set
  `DATABASE_URL` and `NODE_ENV=test`, then run migrations on it.
- Baseline when this audit started: `apps/api` had 392 tests and **24 failing**;
  the Go package `internal/ledger` had **2 failing**. After the fixes the
  integrated run (fresh database, 78 migrations) was **506 tests, 493 pass, 13
  fail** for `apps/api`; the 13 are locked tests that contradict the code (listed
  in `docs/audit/CURRENT_PROJECT_STATUS.md`). Go: all packages pass except the 2
  stale `internal/ledger` tests. `apps/web` 15/15, `packages/money` 40/40,
  `packages/events` 4/4, `scripts` 5/5, `apps/reporting` 12/12 on a clean
  database (5 fail if run after the API suite on the same database, D-2).
  Typecheck and the web/admin builds pass. No browser run was done.
- Single file: `cd apps/api && npx tsx --test --test-concurrency=1 src/path/file.test.ts`.
  Go: `cd apps/settlement && go test ./internal/<pkg>/...`.
