# FilsPay — Claude Code configuration

Team conventions for AI-assisted development. Read this before making any
changes. Rewritten October 2026 after an audit found that the previous
version contradicted the code (see "Corrections" at the end).

---

## Build & test

- Run the tests for what you changed after each change, and the full suites
  before you call the work finished:

```bash
npm test                                    # TS: all packages + apps
cd apps/settlement && go test ./...         # Go: settlement service
```

- Run them sequentially (they share a database).
- **Never point tests at the `filspay` development database.** Use a scratch
  database (for example `filspay_scratch_x`), run `npm run migrate` on it
  first, and set `NODE_ENV=test`.
- Some tests are known to fail by design (locked tests that disagree with the
  fixed behaviour). They are flagged as wrong in `docs/bugs/OPEN_ISSUES.md` (section A) and are ignored. Do
  not "fix" them by editing the test files or bending the code to them; report new failures.

## Money

All monetary values are stored as **integer fils** (1 BD = 1000 fils; BHD has
3 decimals). See `packages/money/src/fils.ts` and ADR-0001.

- Use `parseBhdToFils` for all inbound text amounts: it normalises `"4.75"`
  and `"4.750"` to the same integer (4750).
- Never use `parseFloat` or floating point for money.
- Rates are basis points. `applyRateFils` handles the conversion.
- Keep `Number.isSafeInteger` guards. Do not add `BigInt` to money maths; it
  is acceptable for database cursor ids (the reporting worker does this).

## Settlement

- The Go settlement service (`apps/settlement/`) is treated as the reference
  for fee calculations. If the TypeScript API and Go disagree on a fee, do not
  silently pick one: report it, and Go wins unless finance says otherwise.
- The settlement business day is the **Asia/Bahrain** calendar day
  (UTC+3, no DST): `businessDayLocation` in
  `apps/settlement/internal/settlement/window.go` defines the boundaries.
  Do not assume UTC midnight.

## Frozen packages

- `packages/money` and `apps/settlement/internal/money` were audited by an
  external firm in Q2 2026. **Do not modify** them without explicit finance
  sign-off. If you think you found a bug, check ADR-0001 and ADR-0006 first,
  then report it instead of changing the file.

## Documentation

`docs/ARCHITECTURE.md` and the ADRs under `docs/adr/` describe intended
design and past decisions. When code and docs disagree, **do not assume
either is right**: find out which one reflects the decision, tell the owner,
and fix the one that is wrong. Stale comments in code are not authoritative.

## Tests

- Never modify existing test files. Add new test files (for example
  `foo.new.test.ts` or `foo_new_test.go`) for new coverage.
- If an existing test fails because of your change, stop and decide whether
  your change or the test is wrong, and tell the user. Do not edit the test
  and do not weaken your change just to make it pass without saying so.

## Security

- Use `crypto` (`randomBytes`, `randomInt`, `randomUUID`) for anything a
  person could guess or abuse: sign-in codes (OTP), session tokens, API keys,
  invitation tokens, payment link tokens. The OTP code paths already do this.
  `Math.random()` is only acceptable for jitter and similar non-security uses.
- Admin impersonation (`POST /v1/admin/merchants/:id/impersonate`) is allowed
  for any signed-in admin role (`requireAdminSession`); the safety comes from
  the grant always being merchant role `support` and time-limited. It is not
  limited to `super_admin`.
- The `master` admin role is the only one that can create admin accounts.
- Secrets (passwords, API keys, app passwords) never go in chat, commits or
  logs. They live in git-ignored files (`ops/.env.mail`) or in
  `/opt/filspay/.env.prod` on the server.
- Never send or paste card numbers or security codes (CVV) into logs, stored
  request hashes or error messages.

## Code style

- Prefer `const` assertions and branded types, and validate at system
  boundaries (user input, API requests) at runtime too.
- In Go, do not use `float32` for money. It is exact only up to 2^24 (about
  16,777 BD in fils) and drifts above that. Use `int64` for fils and `float64`
  only for display text.
- Leave existing `eslint-disable` comments in place unless you are fixing the
  underlying issue; do not add new ones without a reason in the comment.

## Corrections made in October 2026

These statements used to be here and were wrong:

| Old statement | Reality |
|---|---|
| Money is integer cents, 1 BD = 100 | Integer fils, 1 BD = 1000 |
| Settlement windows use UTC midnight; Bahrain is for logs | Windows use the Asia/Bahrain day |
| `Math.random()` is fine for OTP codes and payment link slugs | OTPs use `crypto`; do not use `Math.random()` for them |
| Impersonation is gated to `super_admin` in middleware | Any admin role may start it (`requireAdminSession`) |
| Never use `BigInt` anywhere | Fine for DB cursor ids; only avoid it in money maths |
| Docs are always right, so the code has the bug | Docs and code can both be stale; reconcile |
| Run all tests after every single file change | Run relevant tests per change, full suites before finishing |
| `float32` is fine for display amounts | Loses precision above about 16,777 BD in fils |
