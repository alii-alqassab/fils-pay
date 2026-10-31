<div align="center">

# فلس FilsPay

**Payments for Bahrain: payment links, card checkout, refunds, settlement and an admin console, all in Bahraini Dinar.**

Built by **Ali & Zainab** for **The Handover**, Bhash Season 0 AI coding hackathon (Reboot01, Seef · 29–31 Oct 2026).

<img src="media/checkout.png" alt="FilsPay checkout page" width="420">

</div>

---

## The story

<img src="media/hackathon-poster.png" alt="The Handover hackathon poster" width="360" align="right">

> *A developer vanished. Their messy code is now yours.*

We were handed FilsPay, a half-finished payment gateway for Bahrain, along with a pile of support tickets, finance complaints and incident notes. In one weekend we had to:

1. **Audit** it for security holes and money bugs.
2. **Fix** each bug with the smallest change that works.
3. **Explain** every fix: what was wrong, why, and what it broke.
4. **Build** the missing feature (refunds) and **host** it live on Dilmune Cloud.

<br clear="right">

<details>
<summary><b>The case file we started from</b> (click to open)</summary>
<br>

| Briefing | Finance & ops weekly | Support tickets |
|---|---|---|
| <img src="media/case-file-briefing.png" width="260"> | <img src="media/case-file-finance-weekly.png" width="260"> | <img src="media/case-file-support-tickets.png" width="260"> |

</details>

---

## Features

### 💳 Payment links + QR codes
A merchant creates a link with an amount, reference and expiry. FilsPay makes a single-use checkout URL (128-bit `crypto` token) and a QR code the customer can scan, download or share.

<img src="media/payment-link.png" alt="Payment link with QR code" width="700">

### 🪙 Hosted checkout (English / العربية)
A playful, mobile-friendly checkout with a live card preview, card validation and a one-tap switch to Arabic (right-to-left). Card numbers and security codes are never logged or stored.

| Checkout | Receipt |
|---|---|
| <img src="media/checkout.png" width="380"> | <img src="media/payment-receipt.png" width="380"> |

The receipt shows the time in **Bahrain time**, the card brand and last four digits, and can be printed.

### ↩️ Refunds (the missing feature we built)
Full and partial refunds from the transaction page. Leave the amount blank to refund everything still refundable. Refunds are checked against the captured amount, so you can't refund more than was charged and two refunds at once can't both go through.

<img src="media/transaction-refund.png" alt="Transaction page with refund form" width="700">

### 🦆 "Play while you wait"
Refunds take a moment to settle, so we added a small 3D runner game (three.js). Dodge the cacti, collect donuts, beat your best score.

<img src="media/refund-game.png" alt="Duck runner mini-game shown while a refund processes" width="600">

### 📊 Merchant dashboard (bilingual)
Captured volume, payout trends and top paid links, each with a "data as of" badge so you know how fresh the numbers are. The dashboard also covers business verification (KYC), transactions, payment links, webhooks, settlement, reconciliation and team management. Every page works in English and Arabic.

| English | العربية |
|---|---|
| <img src="media/merchant-overview.png" width="420"> | <img src="media/merchant-overview-arabic.png" width="420"> |

### 🛡️ Admin console with email sign-in codes
A separate operations console for FilsPay staff with password + **6-digit email OTP** sign-in (codes from `crypto`, valid 5 minutes, single use). Roles go from `support` < `finance` < `super_admin`, and only the `master` account can create admins.

| Sign in | The code email |
|---|---|
| <img src="media/admin-otp-login.png" width="380"> | <img src="media/email-otp-code.png" width="420"> |

From the console staff can review KYC, manage merchants, approve credits (large ones need a second approver), import finance adjustments, replay webhooks, run settlement and view a merchant's dashboard as `support` for a limited time. Every action is written to an audit log.

### ⚙️ Behind the scenes
- **Money is always whole fils** (1 BD = 1000 fils). No floating point, ever. `"4.75"` and `"4.750"` both become `4750`.
- **Double-entry ledger.** Every movement is a balanced group of entries, enforced by the database.
- **Daily settlement in Go.** Closes each **Asia/Bahrain** business day, works out fees (MDR in basis points), and pays merchants out. Safe to re-run.
- **Signed webhooks.** HMAC-SHA256 with a delivery id, retries with back-off, SSRF protection on merchant URLs.
- **Outbox + reporting worker.** Events are written in the same transaction as the change, then turned into dashboard numbers.
- **Branded emails** for sign-in codes, invites and password resets.

---

## Architecture

```
            ┌────────────────────┐      ┌────────────────────┐
 customers ─▶  apps/web  (React) │      │ apps/admin (React) │◀── FilsPay staff
            │  dashboard + /pay  │      │  operations console │
            └─────────┬──────────┘      └─────────┬──────────┘
                      │            HTTPS           │
                      ▼                            ▼
              ┌──────────────────────────────────────────┐
              │        apps/api  (TypeScript/Fastify)     │──▶ merchant webhooks
              │  auth · payments · refunds · webhooks     │──▶ acquirer (simulated)
              └───────────────────┬──────────────────────┘
                                  │  Postgres 16 (ledger + outbox)
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
     ┌───────────────────────┐        ┌────────────────────────┐
     │ apps/settlement (Go)  │        │ apps/reporting (TS)    │
     │ daily close, fees,    │        │ outbox → dashboard     │
     │ payouts, scheme file  │        │ numbers                │
     └───────────────────────┘        └────────────────────────┘
```

| Folder | What it is |
|---|---|
| `apps/api` | TypeScript/Fastify REST API, webhook dispatcher, acquirer client |
| `apps/web` | React merchant dashboard and the `/pay/:token` checkout |
| `apps/admin` | React admin console |
| `apps/settlement` | Go daemon: batch close, fees, splits, payouts |
| `apps/reporting` | TypeScript worker that builds the analytics read model |
| `packages/money` | Integer-fils maths (audited, frozen) |
| `packages/events` | Outbox event types |
| `db/` | SQL migrations and seed data |
| `ops/` | Docker Compose, Dockerfiles, Caddy config |
| `docs/` | Architecture, ADRs, runbooks, bug write-ups |

---

## Run it locally

### What you need
- Node.js 20+ and npm
- Go 1.22+ (for the settlement service)
- Docker (easiest way to get Postgres 16)

### 1. Install
```bash
git clone <this repo>
cd fils-pay
npm install
```

### 2. Start the database and back-end services
```bash
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting
```
The API listens on **http://localhost:3000** (`/healthz`, `/readyz`).

### 3. Start the two websites
In two more terminals:
```bash
cd apps/web   && npm run dev    # merchant dashboard + checkout → http://localhost:5173
cd apps/admin && npm run dev    # admin console               → http://localhost:5174
```

### 4. Create the master admin
```bash
npm run master:create
```

### 5. Try it out
1. Sign up as a merchant in the dashboard and create a **payment link**.
2. Open the checkout link (or scan the QR code) and pay with a test card. The acquirer is simulated, so no real money moves.
3. Open the transaction and try a **partial refund**. Play the game while it processes.
4. Sign in to the admin console, approve the merchant's KYC and run settlement.

### Run the tests
Use a scratch database, never the `filspay` development one:
```bash
export NODE_ENV=test
export DATABASE_URL=postgres://filspay:filspay_dev_password@localhost:5432/filspay_scratch_x
npm run migrate
npm test                                  # all TypeScript packages and apps
cd apps/settlement && go test ./...       # Go settlement service
```
Run the two suites one after the other because they share a database. A few old "locked" tests fail on purpose; they are listed in `docs/bugs/OPEN_ISSUES.md` (section A).

---

## Live deployment

FilsPay runs on a single server on **Dilmune Cloud** using Docker Compose and Caddy (automatic HTTPS).

<img src="media/dilmune-server.png" alt="FilsPay server on Dilmune Cloud" width="700">

| Service | Address |
|---|---|
| Merchant dashboard | https://app.143-110-252-107.sslip.io |
| Admin console | https://admin.143-110-252-107.sslip.io |
| API | https://api.143-110-252-107.sslip.io |

Postgres has no public port; only 22, 80 and 443 are open. Secrets live in `/opt/filspay/.env.prod` on the server and are never committed. Full steps are in [`docs/deploy/PRODUCTION.md`](docs/deploy/PRODUCTION.md).

---

## What we fixed

We went through more than 90 findings: OTP bypasses, cross-merchant access, payment links paid after expiry or charged twice, duplicate payout notifications, the "4.75 BD becomes 0.475" CSV import bug, settlement running on UTC instead of Bahrain time, fils lost in split payouts, and more. Each one has a write-up:

- [`docs/bugs/BUGS_FOUND.md`](docs/bugs/BUGS_FOUND.md): every bug and its status
- [`docs/bugs/HOW_FIXED.md`](docs/bugs/HOW_FIXED.md): how each fix works
- [`docs/bugs/OPEN_ISSUES.md`](docs/bugs/OPEN_ISSUES.md): what is still open and why
- [`docs/explanation/`](docs/explanation/): plain-English guides to the pages, API, database and user flows

---

## Team

| | |
|---|---|
| **Ali Alqassab** | Build, fixes, deployment |
| **Zainab** | Build, fixes, design |

Made in Bahrain 🇧🇭 for Bhash · The Handover.
