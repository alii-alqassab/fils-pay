# AI agent conventions — FilsPay

Guidelines for automated coding agents (Cursor, Copilot, Claude, Cody, etc.)
working in this repository. Written after an agent silently changed
`packages/money` and broke the settlement reconciliation. Rewritten
October 2026 after an audit found parts of the old version contradicted the
code. **`CLAUDE.md` holds the full, current rules; this file is the short
version and must say the same thing.**

---

## Before you start

1. Read `docs/ARCHITECTURE.md` and the ADRs under `docs/adr/`. Many things
   that look like bugs are documented decisions, but docs can also be stale:
   when code and docs disagree, report it instead of guessing.
2. Read `docs/HANDOVER.md` and `CHANGELOG.md` to see what is done and what is
   in progress.
3. Read `docs/bugs/OPEN_ISSUES.md` for known open problems and for the
   tests that fail on purpose.

## Rules

### Do not modify

- `packages/money/` and `apps/settlement/internal/money/` — frozen after the
  Q2 2026 audit. Changes need finance sign-off.
- Existing test files (`*.test.ts`, `*_test.go`). Add new ones
  (`*.new.test.ts`, `*_new_test.go`) instead. If an old test fails because of
  your change, stop and tell the user; do not edit the test.

### Money

- Amounts are **integer fils** (1 BD = 1000 fils). Not cents.
- Use `parseBhdToFils` for all amount parsing. Never `parseFloat`.
- Do not use `float32` for money in Go. Use `int64`.

### Settlement

- The business day is the **Asia/Bahrain** day (`window.go`), not UTC.
- If TypeScript and Go disagree on a fee, report it; Go is the reference
  unless finance says otherwise.

### API

- `POST /v1/refunds` currently returns 501 (not implemented). Do not wire it
  up without the finance-approved design (see the note in `routes/refunds.ts`).
- `refund.succeeded` is intentionally absent from the webhook-eligible event
  list in `webhooks/dispatcher.ts` until refund webhooks ship. Do not add it
  early.

### Auth & security

- Use `crypto` for OTPs, tokens, invitation links and API keys.
  `Math.random()` is for non-security uses only (jitter).
- Admin impersonation is allowed for any admin session but always grants
  merchant role `support`, time-limited. Only the `master` admin can create
  admin accounts.
- Never put secrets in chat, commits or logs. Never log card numbers or CVV.

### Database

- Money columns are `BIGINT` fils (the volume counter in `platform_stats` is
  the known exception: `INTEGER`, see `docs/bugs/OPEN_ISSUES.md`).
  Do not change column types without a migration plan.
- Never run tests against the `filspay` development database; use a scratch
  database and run `npm run migrate` first.

### Testing

- Run the tests for what you changed, then the full suites before finishing,
  one after the other:
  ```
  npm test
  cd apps/settlement && go test ./...
  ```
