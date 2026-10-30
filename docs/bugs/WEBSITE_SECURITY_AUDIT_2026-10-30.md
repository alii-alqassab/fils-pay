# Website, feature parity and security review — 2026-10-30

The main pages and API routes from the old repository are retained. This version still has release-blocking money and deployment risks. A new concurrency reproduction bypassed the payout balance safeguard. The local refund work also exposes functionality whose finance and downstream integration requirements remain unresolved.

This was an audit, not a remediation deployment. No application code, existing tests, frozen money packages, live records or server configuration were changed by this review.

## Scope and evidence

- Baseline: `https://github.com/MJ5-byte/fils-pay`, HEAD `8b58b0f07a42a1252641f73bb0e94ba444e29223`, downloaded for comparison.
- Current repository: HEAD `9d55206`, including the pre-existing uncommitted changes to `app.ts`, `RefundDrawer.tsx`, `TransactionDetailPage.tsx` and the new merchant refund route/test.
- Read repository rules, architecture, all ADRs, handover, changelog and known issues. Reviewed authentication, authorization, onboarding/KYC, payments/refunds, payment links, webhook transport, reporting, settlement and production configuration.
- Compared all 453 old tracked paths and parsed the old route declarations using the TypeScript AST. All 79 old API route declarations remain in their corresponding route files. This is structural coverage, not proof of identical behavior for every route.
- All old merchant/admin router paths remain. Only one old tracked file is absent: `apps/api/src/reporting/scope.ts`. The current reporting route derives tenant scope directly from authentication instead.
- Read deployed public dashboard/admin HTML and the dashboard JavaScript bundle. Checked HTTPS/security headers, API health and unauthenticated access to merchant identity and the admin merchant list.
- Migrated isolated local scratch databases before database-backed tests. No tests targeted the development `filspay` database. Ran local-only vulnerability reproductions; no attack traffic, card payments, emails or account changes were sent to production.

Limitations: no browser automation surface was available, and no authenticated production session was exercised. Server filesystem, running deployment settings, deployed dependency versions, backup restoration and secret rotation were not independently inspected. Findings in local code/configuration are distinguished below from observations of the public deployment. This review cannot certify that there are no other vulnerabilities.

## Findings requiring attention

### A1 — High: concurrent batches can overpay one merchant (new, reproduced)

Source: `apps/settlement/internal/settlement/batch.go:340–398`.

`PayoutBatch` locks the individual batch, then reads the merchant's aggregate payable position without a shared merchant lock. Two different batches for one merchant can both read the same available balance, both pass the check, and both post payouts. The later merchant monitoring/cache updates serialize writes only after both capacity decisions have already been made.

Reproduction used the actual Go `CloseBatch` and `PayoutBatch` functions against the scratch database. Two closed batches each owed 1,000 fils. Captures initially provided 2,000 fils; a balanced 500-fils deduction left 1,500 available. A transaction held the merchant row with `FOR NO KEY UPDATE`, temporarily pausing each payout at its later monitoring update. After both had passed their balance checks, the lock was released.

Observed result:

```text
available before payouts=1500; batches=1000+1000
held=false,false; payable after=-500
concurrent payouts exceeded payable capacity: -500 fils
```

One payout should have been held. This can arise when different-date runs for the same merchant overlap, for example an admin run alongside the daemon. It does not require replaying the same batch ID. The payout rows/ledger are local accounting in the current simulator-based system; a real bank integration would make the same capacity error financially consequential.

Recommended fix: serialize capacity consumption per merchant before reading available payable, with a lock/atomic reservation discipline shared by the relevant balance-decreasing operations. Checking only the batch lock or serializing a cache update afterward is insufficient. Add concurrent cross-batch and payout/deduction coverage. No change to either frozen money package is needed.

Reproduction artifacts: `/private/tmp/filspay-payout-race-20261030.go`, `/private/tmp/filspay-payout-overlay-20261030.json`, `/private/tmp/filspay-audit-payout-race-20261030.log`. A Go overlay supplied the extra test without adding or changing repository test files.

### A2 — High: production configuration does not persist KYC uploads (new configuration finding)

Sources: `ops/docker-compose.prod.yml:41`, `apps/api/src/config.ts:333`, `apps/api/src/onboarding/kyc.ts:82`.

Uploads and thumbnails are written under the API container's `./data/kyc` default. The production API service has no volume for that directory. Recreating the container during an update therefore loses its uploaded files while Postgres retains document metadata. Review/download then fails, and identity records can be lost.

Recommended fix: use durable private object storage or a dedicated persistent KYC volume, set an explicit storage directory, and back up/restore files together with document metadata. Recover existing files before replacing a container. This follows from the committed deployment configuration; the live server's actual mounts were not inspected.

### A3 — High priority before real payments: vulnerable upload-processing dependency

`package-lock.json` locks `sharp` to `0.33.5`; `generateKycThumbnail` passes authenticated users' uploaded JPEG/PNG data to it. npm audit reports high-severity advisories for sharp and its bundled native image libraries. The upstream [libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj) explicitly includes this version range. Exact exploitability depends on the decoder/format involved; no malicious image was executed.

Recommended fix: upgrade sharp to a release covering all current advisories, verify native dependency versions, rebuild deployment images and retest supported KYC uploads. The audit resolver currently suggests `0.35.5`; review its compatibility rather than using a blind forced update.

The thumbnail path also has no explicit lower pixel budget, upload count/total-byte quota, or route-specific upload throttle. The 8 MiB compressed-file cap does not itself bound decoded image memory. On a small server, repeated uploads can consume disk/CPU. Add suitable pixel and concurrency limits plus merchant storage quotas.

### A4 — High priority release gate: local refunds are enabled while required integrations remain incomplete

Sources: `apps/api/src/app.ts:116`, `apps/api/src/routes/merchantRefunds.ts`, `apps/api/src/payments/processRefund.ts`, `apps/reporting/src/consumer/runConsumerPass.ts:9`, `apps/api/src/webhooks/dispatcher.ts:27`, `docs/bugs/OPEN_ISSUES.md` section B.

The uncommitted code registers `POST /v1/merchants/:merchantId/refunds` and enables the dashboard drawer. Keeping `/v1/refunds` as a 501 does not keep refunds disabled: the alternate route calls the refund implementation.

The new route does have ownership, owner/finance role, amount, hold and idempotency checks. The concern is the release contract: repository instructions and known issues say finance approval, settlement deduction policy and refund status decisions are outstanding. No evidence of their resolution was found during this audit. Refund events are emitted as `refund.succeeded`, but neither reporting's event list nor the webhook eligible list handles them. Successful refunds therefore will not update daily refund rollups or notify receivers through those consumers.

Recommended action: reconcile finance approval and finish the agreed refund lifecycle before releasing this route. Preserve the intentional old stub and webhook exclusions until that coordinated release is approved. Do not enable only one layer.

The deployed public dashboard bundle contains refund status labels but no `/refunds` endpoint string or refund drawer. The current local refund UI is therefore not represented in the inspected live bundle. The live backend's authenticated refund behavior was not tested.

### A5 — Medium: checkout limits can be bypassed by encoding the same token differently (new, reproduced)

Source: `apps/api/src/lib/rateLimit.ts:82–83,107`.

The payment limiter keys on the raw URL path, while routing decodes the token. With a one-request limit in a local test, the first `abc` request reached validation, the second returned 429, but `%61bc`, `a%62c` and `ab%63` all reached validation again. The recorded decoded token was `abc` for every variant.

This weakens checkout/card-attempt throttling; it is not a demonstrated duplicate-payment or authentication bypass. No payment was attempted during the reproduction.

Recommended fix: key on the validated decoded route parameter, reject noncanonical token forms if appropriate, and add a separate per-IP budget so changing target tokens cannot create unlimited independent budgets.

### A6 — Medium: login limits and limiter storage allow resource exhaustion (new, reproduced)

Source: `apps/api/src/lib/rateLimit.ts:17–39,54–56,74–79`.

Merchant/admin login limits apply to IP plus supplied email. Changing the supplied email resets the budget from the same IP, including for nonexistent users whose password check still performs Argon2 work. A local test confirmed that one email was blocked while new emails continued to reach password verification. Add aggregate IP and suitable account/global budgets alongside the existing combined key; this observation does not imply unlimited guesses against one fixed account from one IP.

Also, `maxKeys` only triggers a sweep of expired entries. It neither rejects nor evicts new unexpired keys. A limiter configured with `maxKeys=2` retained five live entries in the reproduction. Distinct attacker-controlled emails/paths can increase memory use and make each subsequent hit sweep the entire live map after the threshold.

Recommended fix: enforce an actual bounded store and define its overload behavior; use a shared store if adding API replicas. Public reproductions were not performed.

### A7 — High impact, documented design choice: API keys have full merchant authority

Source: `apps/api/src/auth/requireMerchantAuth.ts:154`.

API-key actors deliberately bypass session role restrictions. A leaked integration key can manage webhooks/payment links and perform money operations permitted to keys, including the new local refund route. This is not a newly discovered privilege-escalation bug: it is an explicit existing design and known open policy issue.

Recommended decision: introduce explicit scopes and rotation/revocation policy, or require an owner session for integration-management operations. Do not silently redefine existing partner access in a security patch.

### A8 — Medium: “view as merchant” is still incomplete; master role is missing from grant mapping

Sources: `apps/api/src/routes/auth.ts:388–389`, `apps/web/src/auth/DashboardAuthContext.tsx`, `apps/api/src/admin/impersonation.ts:89–93,137`.

The dashboard starts by fetching `/v1/auth/me`, which requires a real merchant session. An impersonation cookie alone cannot pass that check, so a read-only grant does not provide an end-to-end dashboard login. This matches the already documented open issue.

In addition, the mapping contains support, finance and super_admin but omits the newer `master` role. A master-created grant resolves to `merchantRole: undefined` at runtime rather than the documented `support`; role-gated reads can fail. No write escalation was found: impersonation independently blocks non-read methods.

Recommended fix: return a correctly typed read-only identity from an appropriate `/me` flow, add a merchant-side banner and consistently map every admin role to support. A pre-existing merchant session currently takes priority over an impersonation grant, so the UI must also make the effective identity explicit.

### A9 — Medium availability risk: CSV route still buffers the complete export

Sources: `apps/api/src/routes/transactions.ts:220–233`, `apps/api/src/transactions/exportCsv.ts:45–57`.

The actual route uses `buildTransactionsExportCsv`, loading all rows and constructing another full in-memory output. A 31-day date limit does not bound row count or concurrent memory use. The streaming helper exists but is not wired to this route. The changelog's claim that this endpoint streams is stale.

Recommended fix: wire bounded streaming with backpressure or use asynchronous export jobs; otherwise cap row counts and concurrent exports. Existing CSV formula escaping is present and should be preserved.

## Feature comparison

| Area | Comparison / remaining gap |
|---|---|
| Transactions, capture, void, event timeline, CSV | Old route/page declarations retained. Void is local simulator behavior; there is no real acquirer cancel integration. CSV buffering issue remains. |
| Payment-link creation, list, checkout, cancellation | Retained. Detail page still searches only the newest 100 links; an older link's dashboard detail cannot load through that page. See `PaymentLinkDetailPage.tsx:14,50`. |
| Webhook endpoint management, test sends, delivery log, replay | Retained. Refund webhooks intentionally absent. Production DNS validation, address pinning, redirect rejection and bounded response reads are implemented. |
| Settlement list/detail, reconciliation, summaries, admin batch runs | Retained. Concurrent payout capacity is unsafe (A1). Refund deductions are not incorporated into a final finance-approved netting workflow. |
| Analytics and saved reporting filters | Retained. Request-supplied merchant IDs no longer change report tenant scope. Refund rollups are not connected. |
| Admin merchant/KYC, credits, adjustment imports, key rotation, rebuilds | Retained. Known policy gaps include document-free KYC approvals and no second-approver threshold on CSV imports. |
| Merchant signup/onboarding, staff join/approval, master admin invitations, language support | Additions in the current version, rather than removed old features. |
| Impersonation | API grant retained, but dashboard identity flow remains incomplete (A8). |
| Real card acquiring / real bank payout | Not supplied by the old simulator implementation. Current app always constructs the simulator, including production. A frontend `VITE_LIVE_PAYMENTS` flag only changes presentation. |
| Chargebacks / shadow-ledger v2 | No complete user-facing workflow identified. Documentation describes proposed/paused or missing schema work; not counted as a regression of a working old feature. |

## Other known risks and unresolved evidence

- Production deployment documentation says automated backups are not scheduled. Verify actual scheduling and perform a restore test, including KYC files; this audit did not access server backup configuration.
- The known-issues list requires rotation of a formerly committed callback secret. Rotation was not verified. No secret values are included in this report.
- `db/seed/fixtures/production_seed.sql` is still tracked. Its name/description raises a data-provenance question, not proof of a real-data leak. Current `.dockerignore` excludes seed SQL and environment files, so the prior “copied into every new image” finding is partly fixed. Confirm sanitization and whether old public history/images need cleanup.
- All production services use the same database role. In the supplied Postgres image configuration that role is created through `POSTGRES_USER`, so the application credentials have unnecessarily broad database privileges. Separate runtime roles from migration/administration credentials. Production TLS is explicitly disabled for the private Compose database network; do not describe that configured exception as an accidental public database exposure.
- High-value imported adjustments still do not share the credits second-approver workflow. This is an existing finance-policy decision, not an unauthorized fix made during the audit.
- Missing CSP on the public responses is a defense-in-depth improvement, not evidence of a demonstrated XSS vulnerability.
- Architecture/handover and the known-issue list contain stale statements. For example, reporting tenant scope has already been fixed, balance rebuild reads the ledger-backed view, and seed SQL is now excluded from image builds. Reconcile those documents instead of reintroducing their old behavior.

## Dependency results

`npm audit --json` reports **8 affected package entries: 3 high, 5 moderate, 0 critical**. These are advisory package counts, not eight independently exploitable production holes.

| Package | Locked version | Reported severity | Exposure assessment |
|---|---|---|---|
| sharp | 0.33.5 | High | Runtime KYC image processing; prioritize A3. |
| vite | 5.4.21 | High | Development/build tooling. The inspected deployment serves static files through Caddy, so Vite dev-server findings are not automatically public production exposures. |
| source-map-js | 1.2.1 | High | Source-map processing/tooling; no public application path processing arbitrary source maps was established. |
| fastify | 5.12.3 | Moderate | Runtime. Review patches; its HTTP/2-trailer advisory is conditional, and this API uses ordinary Fastify behind Caddy rather than enabling Fastify HTTP/2. |
| fast-uri | See lockfile | Moderate | Transitive dependency. Exploitability depends on vulnerable URI-normalization operations actually used. |
| react-router / react-router-dom | 6.30.6 | Moderate each | Review router updates. This app is client-rendered; the SSR hydration advisory is not evidence of an active SSR exposure here. |
| esbuild | See lockfile | Moderate | Development server/tooling exposure. |

Audit JSON: `/private/tmp/filspay-npm-audit-20261030.json`. Validate upgrades against all current advisories and compatibility. Do not treat `npm audit fix --force` as a reviewed migration plan. A dedicated Go vulnerability scan was not performed.

## Verification results

| Check | Result |
|---|---|
| TypeScript typecheck | Passed across workspaces, database scripts and maintenance scripts. |
| Merchant production build | Passed. |
| Admin production build | Passed. |
| `npm test`: events / money / admin / API / reporting / web | 4/4, 40/40, 7/7, **613/622**, **7/12**, 40/40. Command exits nonzero. |
| API failures | All 9 match the known locked-test exceptions: 4 CSV units, fee-schedule display, discount rebate, 2 callback-route timestamps and 1 inbound-signature timestamp. No existing test was edited. |
| Reporting on a separately migrated empty database | **12/12 passed**. The 5 shared-database failures reproduce the documented contamination problem. |
| Maintenance script tests, invoked separately because the root command failed | 6/6 passed. |
| `go test ./...`, after TypeScript checks | Failed only the 2 known ledger-refresh fixture tests. Other Go packages passed, including settlement. |
| Additional payout concurrency regression, Go overlay | **Failed** with the reproduced negative payable position in A1. This is additional coverage absent from the passing settlement suite. |
| Local rate-limit reproductions | Checkout encoding bypass, rotating-email budget reset and ineffective map-size cap confirmed. |
| Public deployment | Dashboard/admin HTML and API health responded 200. Merchant `/v1/auth/me` and admin `/v1/admin/merchants` returned 401 without credentials. HTTPS, HSTS, nosniff and frame denial observed. |

Test logs are under `/private/tmp/filspay-audit-*-20261030.log`. Two isolated scratch databases were left in local Postgres: `filspay_scratch_audit_20261030` and `filspay_scratch_reporting_audit_20261030`. They contain test fixtures only and were not dropped automatically. Full test logs can contain generated test credentials; they were not copied into this report.

## Suggested order of work

1. Fix and regression-test merchant-wide payout capacity serialization.
2. Persist/recover KYC files and establish tested database/file backups.
3. Upgrade vulnerable runtime image processing and apply pixel/storage/concurrency budgets.
4. Resolve the finance refund release gate and complete downstream refund processing before deployment.
5. Repair canonical checkout limits, aggregate login budgets and bounded limiter storage.
6. Complete impersonation identity handling, old payment-link detail lookup and streamed exports.
7. Decide API-key scopes and high-value adjustment approval rules; verify rotation/data-provenance obligations.
