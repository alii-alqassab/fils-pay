# Accounts, roles, company IDs and real email OTP: design

Status: approved by the owner in chat on 2026-10-30; being implemented. This file is the single spec the code and tests follow.

## 1. What the owner asked for

1. Wipe the database.
2. **One master account** ("the big boss"). Only the master can create admin accounts.
3. A **merchant (company) account** is first created by its **owner** and must wait for **admin approval**.
4. When the admin approves, the website gives the company a **unique company ID**.
5. **Company staff** use that ID to create their accounts. Each staff account must be **approved by the owner**.
6. **OTP codes are sent by real email** from now on.

## 2. Roles (final)

### Internal side (admin console, `apps/admin`)

| Role | Who | Can do |
|---|---|---|
| `master` | exactly one person | Everything `super_admin` can, plus: invite, enable, disable and re-role admins; send admin password resets. Nobody else can. |
| `super_admin` | created by master | All current super_admin powers (money, settlement, credits, impersonation). Cannot manage admins. |
| `finance` | created by master | Approve or reject companies (KYC), money and settlement actions. |
| `support` | created by master | Look-ups, replays, small credits (unchanged). |

Rules the code enforces:
- There can be only **one** `master` (database unique index). No API can create, promote, demote, disable or delete the master. The master is created only by a server-side command (`npm run master:create`).
- Admin accounts are never created with a password chosen by someone else. The master enters an email, name and role; the person receives an **invitation email with a one-time link** (valid 48 hours, stored hashed) and chooses their own password. The master never sees a password.
- A forgotten admin password is fixed by the master sending a new invitation ("reset"). A forgotten master password is fixed with `npm run master:reset` on the server.
- Every admin-account action is written to the admin audit log.
- Every admin login still needs the emailed OTP, including the master.

### Company side (merchant dashboard, `apps/web`)

| Role | Who | Can do |
|---|---|---|
| `owner` | the person who registers the company (one per company) | Everything in the company, plus approve or reject join requests and manage the team. |
| `finance` | staff approved by the owner | Money pages (payment links, webhooks, settlement, reconciliation). |
| `support` | staff approved by the owner | Look-up only. |

## 3. Flows

### 3.1 Company registration (owner)
1. Owner opens **Register company** (`/dashboard/register`) and enters business details, email and password. Existing public signup creates the company (`onboarding_status = submitted`) and the owner.
2. Owner signs in (password, then emailed OTP) and uploads KYC documents. Until approval the dashboard shows **"Waiting for admin approval"** and the company cannot take payments or create payment links (the API refuses with `merchant_not_approved`).
3. An admin (`finance`, `super_admin` or `master`) reviews and approves or rejects in the admin console. The review, the audit row and the company ID are written in one transaction.
4. On approval the database assigns a **company ID** like `FP-7K3M-9QXA` (8 random characters from an alphabet without look-alike letters, about 40 bits, unique index). The owner gets an email with the ID, and sees it on the dashboard with a copy button. A rejected company gets an email with the reviewer's note.

### 3.2 Staff join (needs the company ID)
1. A staff member opens **Join a company** (`/dashboard/join`) and enters: company ID, full name, email, password, and the role they ask for (`finance` or `support`; never `owner`).
2. The account is created as `pending_owner_approval`. The owner is emailed. The staff member sees "Request sent. The company owner must approve it".
3. Before approval the person **cannot sign in** (after the password is checked they get "waiting for owner approval").
4. The owner opens **Team** (`/dashboard/team`), sees pending requests and members, and can approve (optionally changing the role), reject, disable, re-enable, or change a role. The staff member is emailed the result.
5. A disabled or rejected person cannot sign in and their sessions are revoked immediately.

### 3.3 Admin creation (master only)
1. Master opens **Admins** (`/admins` in the console) and invites: email, name, role (`support`, `finance`, `super_admin`).
2. The invitee receives an email with a link `…/accept-invite?token=…`, sets a password (at least 12 characters) and can then sign in with an emailed OTP.
3. The master can resend, revoke, disable, enable and change the role of any admin except the master.

### 3.4 Sign-in with real email OTP (both sides)
- Password first, then a 6-digit code sent by email (5-minute lifetime, 5 attempts, resend throttled to once per 30 s; unchanged).
- The code is **never** returned in an API response and **never** logged, except when `NODE_ENV=test` (automated tests) or `OTP_DELIVERY=log` is set explicitly.
- If email is not configured, sign-in fails with a clear message and the pending session is revoked; it never silently falls back to showing the code.

## 4. Email delivery

One mail module (`lib/mail.ts`) with two providers, chosen by configuration:
- **Resend** when `RESEND_API_KEY` and `OTP_FROM_EMAIL` are set.
- **SMTP** (nodemailer) when `SMTP_HOST` is set: `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM`.
- If both are set, Resend wins. If neither is set, sending throws a clear configuration error.
- Credentials live in `ops/.env.mail` (git-ignored, loaded by compose as an optional file). A template `ops/.env.mail.example` is committed. Nothing secret is committed.
- Emails sent: sign-in OTP (merchant, admin); admin invitation and reset; company approved (with ID) and rejected; join request (to the owner); join approved and rejected (to the staff member).
- Tests use an in-memory transport; no real email is sent by tests.

## 5. Data model (new migrations, additive)

| Migration | Change |
|---|---|
| `0084_master_admin_role` | `admin_users.role` also allows `master`; unique partial index so at most one master exists. |
| `0085_admin_account_invites` | New table `admin_account_invites` (email, display name, role, purpose `invite` or `reset`, hashed token, expiry, redeemed/revoked time, created by). The old unused `admin_invites` table is left alone. |
| `0086_company_codes_and_staff_approval` | `merchants.company_code` (unique); function and trigger that assign a code when a company becomes `approved`; `merchant_users.status` (`active`, `pending_owner_approval`, `rejected`, `disabled`, default `active` so existing rows and tests keep working), `full_name`, `approved_by_user_id`, `approved_at`, `requested_role`. |

## 6. API (new or changed)

Admin side (all master-only unless noted; every call is audited):
- `GET /v1/admin/admins`: admins and pending invitations.
- `POST /v1/admin/admins/invites`, `POST …/invites/:id/resend`, `DELETE …/invites/:id`.
- `PATCH /v1/admin/admins/:id`: role or status (never the master).
- `POST /v1/admin/admins/:id/reset`: send a password-reset invitation.
- `POST /v1/admin/auth/accept-invite` (public, rate limited): token plus new password.
- `requireAdminRole` treats `master` as allowed everywhere a role check lists `super_admin`.

Merchant side:
- `POST /v1/company-join` (public, rate limited): company ID, name, email, password, requested role.
- `GET /v1/team`, `POST /v1/team/:id/approve`, `POST /v1/team/:id/reject`, `PATCH /v1/team/:id` (owner only).
- `GET /v1/auth/me` also returns `companyCode` (owner only, after approval) and the user's status.
- Sign-in refuses `pending_owner_approval`, `rejected` and `disabled` users after the password check; session lookup requires `status = 'active'`.
- Creating payment links requires an approved company.

## 7. Gaps filled beyond the request (decisions made)

1. Company IDs come from a database trigger, so every approval path (single, bulk, scripts, seed) gets one.
2. Staff can only join **approved** companies (the ID does not exist before).
3. Join requests are rate limited per IP and capped per company (20 pending) to stop spam and guessing.
4. Owner cannot disable, demote or reject themselves; there is one owner per company.
5. Admin invitation tokens are 32 random bytes, stored only as a hash, single use.
6. Master recovery commands exist (`master:create`, `master:reset`) so the company is never locked out.
7. Disabling a person revokes their sessions at once.
8. Notification emails never block the action: if one fails the action still succeeds and the failure is logged.
9. The login page text now says "we emailed you a code" and no longer shows a code.
10. Existing locked tests keep running with `NODE_ENV=test`, where codes are still logged and returned.

## 8. Rollout steps

1. Stop `api`, `settlement`, `reporting`; wipe the `filspay` database (drop and recreate the `public` schema, because the append-only ledger forbids `TRUNCATE`); re-run all migrations.
2. Create the master with `npm run master:create -- --email <address>` (the password is typed at a hidden prompt, or set once through the emailed reset).
3. Put mail credentials in `ops/.env.mail`.
4. `docker compose -f ops/docker-compose.yml build api` and `up -d api settlement reporting` (the image holds a copy of the code).
5. Sign in to the admin console as master (OTP arrives by email), invite admins, then register a test company.

## 9. Tests

New `*.new.test.ts` files (no existing test is edited): master uniqueness and immutability, invite create/redeem/expire/revoke/reuse, role gates, company-code trigger and uniqueness, join/approve/reject/disable flows and login refusals, session revocation, OTP delivery modes (email, log, not configured), mail provider selection, rate-limit rules. Then the full suites are re-run and compared with the previous results (493 passing, 13 known failing in `apps/api`).

## 10. Status (2026-10-30) and how to operate it

Implemented and verified:
- Unit and database tests: 63 new tests in `*.new.test.ts` files; `apps/api` 574 tests, 561 passing, the same 13 known protected-test failures as before and nothing new.
- End to end against the live Docker stack with a local mail catcher (real SMTP path): 41 of 41 journey checks (master login by emailed code, admin invitation, company registration, approval with company ID email, staff join and owner approval, disabling), and 13 of 13 browser checks in headless Chrome (new pages render, no browser errors). The temporary test data and test mail settings were removed afterwards.
- Not tested: a delivery through a real provider (Resend or a real SMTP account), because that needs your credentials. The Resend request shape is unit-tested.

Day-to-day commands (repo root):
```sh
# 1. Mail settings (git-ignored): copy the template, fill in Resend OR SMTP
cp ops/.env.mail.example ops/.env.mail
docker compose -f ops/docker-compose.yml up -d api        # restart so it reads the file
docker logs ops-api-1 2>&1 | grep "index\]"                # must say: sign-in codes are sent by email (resend|smtp)

# 2. Create the one master account (pick ONE way)
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable'
npm run master:create -- --email you@example.com --name "Your Name" --setup-email   # emails you a link to choose the password
npm run master:create -- --email you@example.com --name "Your Name"                  # or: type the password at a hidden prompt (own terminal)

# 3. Lost the master password
npm run master:reset -- --setup-email

# After changing API code the container must be rebuilt
docker compose -f ops/docker-compose.yml build api && docker compose -f ops/docker-compose.yml up -d api
```
Sign in to the admin console at http://localhost:5174 as the master, open **Admins**, invite your admins. Companies register at http://localhost:5173/dashboard/register; staff join at /dashboard/join with the company ID.
