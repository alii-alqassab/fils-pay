/**
 * App-wide configuration, loaded once from environment variables at boot.
 * `loadConfig` throws synchronously — crashing boot rather than serving
 * traffic in a half-configured state — if `DATABASE_URL` is missing, or if
 * `SETTLEMENT_INTERNAL_TOKEN` is missing while `nodeEnv === 'production'`.
 *
 * Later sub-phases add their own fields to this same interface/loader
 * rather than introducing a second config system.
 */
export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  /** Exact browser origins allowed to make credentialed API requests. */
  browserOrigins?: string[];

  pgPoolMax: number;
  pgPoolMin: number;
  pgPoolIdleTimeoutMs: number;
  pgPoolConnectionTimeoutMs: number;

  sessionTtlHours: number;
  pendingSessionTtlMinutes: number;
  otpTtlMinutes: number;
  otpCodeLength: number;
  otpMaxAttempts: number;
  otpDevExpose: boolean;
  otpEmailApiKey?: string;
  otpFromEmail?: string;
  /** How sign-in codes reach the user. "email" (the default everywhere except
   *  NODE_ENV=test) sends a real email and never returns or logs the code.
   *  "log" prints the code to the API log and (outside production) returns it
   *  in the login response; it is for automated tests and explicit local use. */
  otpDelivery?: "email" | "log";
  /** SMTP sender, used when RESEND_API_KEY is not set. */
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  /** true = implicit TLS (usually port 465); false = STARTTLS when offered. */
  smtpSecure?: boolean;
  /** From address for SMTP email; falls back to OTP_FROM_EMAIL. (Resend uses OTP_FROM_EMAIL.) */
  mailFrom?: string;
  /** Reject browser requests whose Origin is not one of BROWSER_ORIGINS (default true).
   *  Set ENFORCE_ORIGIN=false only to debug. Requests without an Origin header are never affected. */
  enforceOrigin?: boolean;
  /** Which provider is tried first when both Resend and SMTP are configured.
   *  The other one is used as a fallback if the first fails. Default "auto" = Resend first. */
  mailProvider?: "auto" | "resend" | "smtp";
  /** Public addresses used inside emailed links. */
  adminConsoleUrl?: string;
  dashboardUrl?: string;

  argon2MemoryKib: number;
  argon2TimeCost: number;
  argon2Parallelism: number;

  kycUploadDir: string;
  kycMaxFileSizeBytes: number;

  acquirerLatencyMinMs: number;
  acquirerLatencyMaxMs: number;
  acquirerFailureRate: number;
  acquirerRngSeed: number | null;

  cookieName: string;
  cookieSecure: boolean;

  /** Cookie carrying an `admin_sessions` token. A completely separate name,
   *  table, and code path from `cookieName`/`sessions` — `requireAdminSession`
   *  reads only this one and `requireMerchantAuth` never reads it at all, so
   *  an admin session can never be resolved as merchant authority. */
  adminCookieName: string;
  /** Deliberately shorter than a merchant session's 12h — a minor extra
   *  caution for the higher-privilege plane. */
  adminSessionTtlHours: number;
  adminPendingSessionTtlMinutes: number;
  adminOtpTtlMinutes: number;
  adminOtpCodeLength: number;
  adminOtpMaxAttempts: number;

  /** Cookie carrying an `admin_impersonation_grants` token — the third,
   *  distinct cookie in the system. Read only by `requireMerchantAuth`, and
   *  never by `requireAdminSession`: the privilege drop is structural, not a
   *  flag that could fail to be cleared. */
  impersonationCookieName: string;
  /** Bounded lifetime of a "view as merchant" grant. Checked on every
   *  lookup — there is no "until logout" path. */
  impersonationTtlMinutes: number;

  /** Base URL of apps/settlement's internal HTTP server, reachable only
   *  inside the compose network. The API delegates settlement operations
   *  (batch runs, balance refreshes) through this. */
  settlementInternalUrl: string;
  /** Bearer token for that internal server. Required in production, same
   *  posture the retired `internalApiToken` had. */
  settlementInternalToken: string;
  /** Timeout for an internal settlement call. Generous on purpose: a full
   *  daily batch across every merchant genuinely takes longer than a typical
   *  API-latency budget. */
  settlementInternalRequestTimeoutMs: number;

  /** Base URL of apps/web's hosted checkout, used only to build the
   *  convenience `url` field on a created payment link — the API itself
   *  has no other reason to know where apps/web is hosted, and no route
   *  redirects there. Default matches Vite's own default dev port. */
  checkoutBaseUrl: string;
  /** How long a payment link stays 'reserved' (claimed by an in-flight pay
   *  attempt) before it self-expires back to claimable, closing the gap
   *  between claim and finalize without a sweep job. */
  paymentLinkReservationTimeoutSeconds: number;

  /** Base64-encoded 32 raw bytes, the single application-level AES-256-GCM
   *  key `webhooks/secretCrypto.ts` uses to encrypt/decrypt
   *  `webhook_endpoints.secret_ciphertext`. Required in every environment
   *  (not just production) — the platform must be able to actually encrypt
   *  and later recover a webhook secret's plaintext at send time, so there
   *  is no "dev doesn't need this" story the way there is for
   *  `settlementInternalToken`. `loadConfig` decodes and validates the length,
   *  failing boot on a missing or malformed value rather than accepting
   *  garbage and failing later at first-delivery time. Callers pass
   *  `Buffer.from(config.webhookSecretEncryptionKey, "base64")` to
   *  `encryptSecret`/`decryptSecret`, which take a `Buffer` key. */
  webhookSecretEncryptionKey: string;
  /** Terminal-failure threshold for a single webhook_deliveries row — the
   *  attempt at which status flips from 'pending' to 'exhausted' instead of
   *  scheduling another retry. */
  webhookMaxAttempts: number;
  /** Exponential backoff base (attempt 1's delay), milliseconds. */
  webhookBackoffBaseMs: number;
  /** Exponential backoff cap — no retry ever waits longer than this,
   *  milliseconds. */
  webhookBackoffCapMs: number;
  /** How often the dispatcher's poll-fallback timer runs a dispatch pass,
   *  independent of LISTEN/NOTIFY — the safety net that guarantees no event
   *  is stuck forever even if a NOTIFY is missed. */
  webhookPollIntervalMs: number;
  /** Per-delivery-attempt HTTP timeout passed to the transport, milliseconds. */
  webhookRequestTimeoutMs: number;

  /** Shared secret the acquirer signs its async callbacks with
   *  (routes/acquirerCallbacks.ts). Platform-level, not per-merchant —
   *  unlike webhookSecretEncryptionKey, there is exactly one acquirer
   *  relationship, not one secret per registered endpoint. */
  acquirerCallbackSigningSecret: string;
  /** Set true once the sandbox signs everything. */
  acquirerCallbackRequireSignature: boolean;

  // --- Rate limiting / proxy trust (DISC-S-2, S-16, S-17) ---------------
  // Optional so hand-built Config fixtures keep compiling; app.ts applies
  // the same defaults via resolveRateLimitConfig().
  /** Master switch. Default: on, except NODE_ENV=test (off unless
   *  RATE_LIMIT_ENABLED=true). The store is in-process memory, so limits are
   *  per node; a multi-replica deployment needs a shared store (e.g. Redis). */
  /** Rotate the session token when OTP verification succeeds (session-fixation defence). */
  rotateSessionOnOtpVerify?: boolean;
  rateLimitEnabled?: boolean;
  /** Fastify `trustProxy`: false (default), true, a hop count, or a list of
   *  trusted proxy IPs/CIDRs. Only set when behind a proxy that overwrites
   *  X-Forwarded-For; otherwise clients can spoof their IP and dodge limits. */
  trustProxy?: boolean | number | string[];
  /** login + email-login: per minute per IP+normalized email. */
  rateLimitLoginPerMinute?: number;
  /** otp verify/resend (merchant and admin): per minute per IP. */
  rateLimitOtpPerMinute?: number;
  /** admin login: per minute per IP+normalized email. */
  rateLimitAdminLoginPerMinute?: number;
  /** public payment-link pay: per minute per IP+token. */
  rateLimitPayPerMinute?: number;
  /** public merchant signup: per hour per IP. */
  rateLimitSignupPerHour?: number;
  /** Max candidate users verified (argon2) per email-login request. */
  loginMaxCandidates?: number;
}

function parseNodeEnv(value: string | undefined): Config["nodeEnv"] {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  // Unset keeps the development default, but a typo ("prod", "Production")
  // must not silently downgrade a deployment to dev defaults.
  if (value !== undefined && value !== "") {
    throw new Error(
      `loadConfig: NODE_ENV must be one of production, test, development (got "${value}")`,
    );
  }
  return "development";
}

/** Throws if the connection string explicitly disables TLS. Production only;
 *  DATABASE_ALLOW_NO_TLS=true is the explicit opt-out for a private network. */
function assertProductionDatabaseTls(databaseUrl: string, env: NodeJS.ProcessEnv): void {
  if (env.DATABASE_ALLOW_NO_TLS === "true") return;
  if (/[?&]sslmode=disable(?:&|$)/i.test(databaseUrl)) {
    throw new Error(
      "loadConfig: DATABASE_URL has sslmode=disable in production (set DATABASE_ALLOW_NO_TLS=true to override on a private network)",
    );
  }
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected an integer, got "${value}"`);
  }
  return parsed;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected a number, got "${value}"`);
  }
  return parsed;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

const DEV_FALLBACK_WEBHOOK_KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates WEBHOOK_SECRET_ENCRYPTION_KEY decodes to exactly 32 raw bytes,
 *  failing fast at boot (same posture as DATABASE_URL) rather than
 *  accepting a missing/malformed key and only discovering the problem at
 *  first-delivery time. Returns the original base64 string unchanged — the
 *  Config field stays base64-encoded; callers decode to a Buffer at the
 *  point of use. */
function parseWebhookSecretEncryptionKey(value: string | undefined): string {
  if (!value) {
    throw new Error("loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY environment variable is not set");
  }
  if (!BASE64_RE.test(value)) {
    throw new Error("loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY is not valid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY must base64-decode to exactly 32 bytes, got ${decoded.length}`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("loadConfig: DATABASE_URL environment variable is not set");
  }

  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const browserOrigins = (env.BROWSER_ORIGINS ?? (nodeEnv === "production" ? "" : "http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of browserOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (nodeEnv === "production" && parsed.protocol !== "https:")) {
      throw new Error("loadConfig: BROWSER_ORIGINS must contain exact HTTPS origins in production");
    }
  }

  const settlementInternalToken = env.SETTLEMENT_INTERNAL_TOKEN ?? "";
  if (nodeEnv === "production" && settlementInternalToken === "") {
    throw new Error("loadConfig: SETTLEMENT_INTERNAL_TOKEN is required when NODE_ENV=production");
  }
  if (nodeEnv === "production" && settlementInternalToken === "dev-token") {
    throw new Error("loadConfig: SETTLEMENT_INTERNAL_TOKEN must not be the dev default when NODE_ENV=production");
  }
  if (nodeEnv === "production") {
    assertProductionDatabaseTls(databaseUrl, env);
    if (env.WEBHOOK_SECRET_ENCRYPTION_KEY === DEV_FALLBACK_WEBHOOK_KEY_B64) {
      throw new Error("loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY must not be the dev default when NODE_ENV=production");
    }
    if (parseBoolEnv(env.COOKIE_SECURE, true) === false) {
      throw new Error("loadConfig: COOKIE_SECURE=false is not allowed when NODE_ENV=production");
    }
    if (parseBoolEnv(env.OTP_DEV_EXPOSE, false)) {
      throw new Error("loadConfig: OTP_DEV_EXPOSE=true is not allowed when NODE_ENV=production");
    }
  }

  const acquirerCallbackSigningSecret = env.ACQUIRER_CALLBACK_SIGNING_SECRET ?? "";
  if (nodeEnv === "production" && acquirerCallbackSigningSecret === "") {
    throw new Error("loadConfig: ACQUIRER_CALLBACK_SIGNING_SECRET is required when NODE_ENV=production");
  }

  // Sign-in codes are emailed for real everywhere except automated tests.
  const otpDelivery = parseOtpDelivery(env.OTP_DELIVERY, nodeEnv);

  return {
    nodeEnv,
    port: parseIntEnv(env.PORT, 3000),
    databaseUrl,
    browserOrigins,

    pgPoolMax: parseIntEnv(env.PG_POOL_MAX, 5),
    pgPoolMin: parseIntEnv(env.PG_POOL_MIN, 0),
    pgPoolIdleTimeoutMs: parseIntEnv(env.PG_POOL_IDLE_TIMEOUT_MS, 30_000),
    pgPoolConnectionTimeoutMs: parseIntEnv(env.PG_POOL_CONNECTION_TIMEOUT_MS, 5_000),

    sessionTtlHours: parseIntEnv(env.SESSION_TTL_HOURS, 12),
    pendingSessionTtlMinutes: parseIntEnv(env.PENDING_SESSION_TTL_MINUTES, 10),
    otpTtlMinutes: parseIntEnv(env.OTP_TTL_MINUTES, 5),
    otpCodeLength: parseIntEnv(env.OTP_CODE_LENGTH, 6),
    otpMaxAttempts: parseIntEnv(env.OTP_MAX_ATTEMPTS, 5),
    // The code is only ever returned in the login response when delivery is
    // "log" (tests / explicit local use). Real email delivery never exposes it.
    otpDevExpose: parseBoolEnv(env.OTP_DEV_EXPOSE, otpDelivery === "log" && nodeEnv !== "production"),
    otpEmailApiKey: env.RESEND_API_KEY || undefined,
    otpFromEmail: env.OTP_FROM_EMAIL || undefined,
    otpDelivery,
    smtpHost: env.SMTP_HOST || undefined,
    smtpPort: parseIntEnv(env.SMTP_PORT, 587),
    smtpUser: env.SMTP_USER || undefined,
    smtpPass: env.SMTP_PASS || undefined,
    smtpSecure: parseBoolEnv(env.SMTP_SECURE, false),
    mailFrom: env.MAIL_FROM || undefined,
    mailProvider: parseMailProvider(env.MAIL_PROVIDER),
    enforceOrigin: parseBoolEnv(env.ENFORCE_ORIGIN, true),
    adminConsoleUrl: (env.ADMIN_CONSOLE_URL || "http://localhost:5174").replace(/\/+$/, ""),
    dashboardUrl: (env.DASHBOARD_URL || "http://localhost:5173").replace(/\/+$/, ""),

    argon2MemoryKib: parseIntEnv(env.ARGON2_MEMORY_KIB, 19_456),
    argon2TimeCost: parseIntEnv(env.ARGON2_TIME_COST, 2),
    argon2Parallelism: parseIntEnv(env.ARGON2_PARALLELISM, 1),

    kycUploadDir: env.KYC_UPLOAD_DIR ?? "./data/kyc",
    kycMaxFileSizeBytes: parseIntEnv(env.KYC_MAX_FILE_SIZE_BYTES, 8_388_608),

    acquirerLatencyMinMs: parseIntEnv(env.ACQUIRER_LATENCY_MIN_MS, 100),
    acquirerLatencyMaxMs: parseIntEnv(env.ACQUIRER_LATENCY_MAX_MS, 400),
    acquirerFailureRate: parseFloatEnv(env.ACQUIRER_FAILURE_RATE, 0.02),
    acquirerRngSeed:
      env.ACQUIRER_RNG_SEED !== undefined && env.ACQUIRER_RNG_SEED !== ""
        ? parseIntEnv(env.ACQUIRER_RNG_SEED, 0)
        : null,

    cookieName: env.COOKIE_NAME ?? "fp_sid",
    cookieSecure: parseBoolEnv(env.COOKIE_SECURE, nodeEnv === "production"),

    adminCookieName: env.ADMIN_COOKIE_NAME ?? "fp_admin_sid",
    adminSessionTtlHours: parseIntEnv(env.ADMIN_SESSION_TTL_HOURS, 8),
    adminPendingSessionTtlMinutes: parseIntEnv(env.ADMIN_PENDING_SESSION_TTL_MINUTES, 10),
    adminOtpTtlMinutes: parseIntEnv(env.ADMIN_OTP_TTL_MINUTES, 5),
    adminOtpCodeLength: parseIntEnv(env.ADMIN_OTP_CODE_LENGTH, 6),
    adminOtpMaxAttempts: parseIntEnv(env.ADMIN_OTP_MAX_ATTEMPTS, 5),

    impersonationCookieName: env.IMPERSONATION_COOKIE_NAME ?? "fp_impersonation",
    impersonationTtlMinutes: parseIntEnv(env.IMPERSONATION_TTL_MINUTES, 15),

    settlementInternalUrl: env.SETTLEMENT_INTERNAL_URL ?? "http://settlement:8091",
    settlementInternalToken,
    settlementInternalRequestTimeoutMs: parseIntEnv(env.SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS, 30_000),

    checkoutBaseUrl: env.CHECKOUT_BASE_URL ?? "http://localhost:5173",
    paymentLinkReservationTimeoutSeconds: parseIntEnv(env.PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS, 60),

    webhookSecretEncryptionKey: parseWebhookSecretEncryptionKey(
      env.WEBHOOK_SECRET_ENCRYPTION_KEY || (nodeEnv !== "production" ? DEV_FALLBACK_WEBHOOK_KEY_B64 : undefined),
    ),
    webhookMaxAttempts: parseIntEnv(env.WEBHOOK_MAX_ATTEMPTS, 8),
    webhookBackoffBaseMs: parseIntEnv(env.WEBHOOK_BACKOFF_BASE_MS, 30_000),
    webhookBackoffCapMs: parseIntEnv(env.WEBHOOK_BACKOFF_CAP_MS, 21_600_000),
    webhookPollIntervalMs: parseIntEnv(env.WEBHOOK_POLL_INTERVAL_MS, 5_000),
    webhookRequestTimeoutMs: parseIntEnv(env.WEBHOOK_REQUEST_TIMEOUT_MS, 10_000),

    acquirerCallbackSigningSecret,
    acquirerCallbackRequireSignature: parseBoolEnv(
      env.ACQUIRER_CALLBACK_REQUIRE_SIGNATURE,
      nodeEnv === "production",
    ),

    rotateSessionOnOtpVerify: parseBoolEnv(env.ROTATE_SESSION_ON_OTP_VERIFY, nodeEnv === "production"),
    rateLimitEnabled: parseBoolEnv(env.RATE_LIMIT_ENABLED, nodeEnv !== "test"),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitLoginPerMinute: parseIntEnv(env.RATE_LIMIT_LOGIN_PER_MINUTE, 10),
    rateLimitOtpPerMinute: parseIntEnv(env.RATE_LIMIT_OTP_PER_MINUTE, 10),
    rateLimitAdminLoginPerMinute: parseIntEnv(env.RATE_LIMIT_ADMIN_LOGIN_PER_MINUTE, 10),
    rateLimitPayPerMinute: parseIntEnv(env.RATE_LIMIT_PAY_PER_MINUTE, 20),
    rateLimitSignupPerHour: parseIntEnv(env.RATE_LIMIT_SIGNUP_PER_HOUR, 10),
    loginMaxCandidates: parseIntEnv(env.LOGIN_MAX_CANDIDATES, 5),
  };
}

/** MAIL_PROVIDER: "auto" (default), "resend" or "smtp": which configured provider is tried first. */
function parseMailProvider(value: string | undefined): "auto" | "resend" | "smtp" {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "auto") return "auto";
  if (v === "resend" || v === "smtp") return v;
  throw new Error(`loadConfig: MAIL_PROVIDER must be "auto", "resend" or "smtp", got "${value}"`);
}

/** OTP_DELIVERY: "email" or "log". Default: "log" for NODE_ENV=test, "email"
 *  everywhere else. "log" is refused in production. */
function parseOtpDelivery(value: string | undefined, nodeEnv: Config["nodeEnv"]): "email" | "log" {
  const v = (value ?? "").trim().toLowerCase();
  const chosen = v === "" ? (nodeEnv === "test" ? "log" : "email") : v;
  if (chosen !== "email" && chosen !== "log") {
    throw new Error(`loadConfig: OTP_DELIVERY must be "email" or "log", got "${value}"`);
  }
  if (chosen === "log" && nodeEnv === "production") {
    throw new Error('loadConfig: OTP_DELIVERY=log is not allowed when NODE_ENV=production');
  }
  return chosen;
}

/** TRUST_PROXY: unset/"false" -> false; "true" -> true; digits -> hop count;
 *  otherwise a comma-separated IP/CIDR list. */
function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const v = (value ?? "").trim();
  if (v === "" || v === "false" || v === "0") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v.split(",").map((part) => part.trim()).filter((part) => part !== "");
}
