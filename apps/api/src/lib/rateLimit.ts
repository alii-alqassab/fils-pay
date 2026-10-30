import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { TooManyRequestsError } from "./errors.js";

/**
 * Minimal fixed-window rate limiter (DISC-S-2). In-process memory only: the
 * counters are per node, so with several API replicas the effective limit is
 * limit x replicas. A multi-replica deployment needs a shared store (Redis or
 * Postgres) behind the same `hit()` interface.
 *
 * Rules are matched by method + URL path in one app-level hook so the route
 * files themselves are untouched. Keys are hashed; credentials are never
 * stored or logged.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweepAt = 0;

  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 50_000) {}

  /** Records one hit. Returns null when allowed, else seconds until reset. */
  hit(key: string, limit: number, windowMs: number): number | null {
    const t = this.now();
    this.sweep(t);
    const w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      // The store is bounded: when it is full of live windows, a brand-new key is refused
      // instead of growing memory without limit (fails closed; per-IP rules run first so one
      // address cannot fill it).
      if (!w && this.windows.size >= this.maxKeys) return Math.max(1, Math.ceil(windowMs / 1000));
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return null;
    }
    w.count += 1;
    if (w.count > limit) return Math.max(1, Math.ceil((w.resetAt - t) / 1000));
    return null;
  }

  private sweep(t: number): void {
    if (t < this.nextSweepAt && this.windows.size < this.maxKeys) return;
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
    this.nextSweepAt = t + 60_000;
  }
}

interface Rule {
  name: string;
  match: (path: string) => boolean;
  limit: number;
  windowMs: number;
  key: (ip: string, body: Record<string, unknown>, path: string) => string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * The path the router will actually use: percent-escapes decoded per segment, so `%61bc` and
 * `abc` share one budget. Falls back to the raw path if it is not valid encoding or decodes to
 * something containing a slash or NUL.
 */
export function canonicalPath(rawPath: string): string {
  try {
    const decoded = rawPath
      .split("/")
      .map((segment) => {
        const d = decodeURIComponent(segment);
        if (d.includes("/") || d.includes("\0")) throw new Error("non-canonical");
        return d;
      })
      .join("/");
    return decoded;
  } catch {
    return rawPath;
  }
}

function emailKey(ip: string, body: Record<string, unknown>): string {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  return `${ip}|${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
}

/** Defaults mirror config.ts; used when a hand-built Config omits the fields. */
export function resolveRateLimitConfig(config: Config) {
  return {
    enabled: config.rateLimitEnabled ?? config.nodeEnv !== "test",
    loginPerMinute: config.rateLimitLoginPerMinute ?? 10,
    otpPerMinute: config.rateLimitOtpPerMinute ?? 10,
    adminLoginPerMinute: config.rateLimitAdminLoginPerMinute ?? 10,
    payPerMinute: config.rateLimitPayPerMinute ?? 20,
    signupPerHour: config.rateLimitSignupPerHour ?? 10,
  };
}

function buildRules(c: ReturnType<typeof resolveRateLimitConfig>): Record<string, Rule[]> {
  return {
    POST: [
      // Per-address budgets across ALL emails / tokens, checked before the per-target ones: changing
      // the email or token no longer resets the budget, and one address cannot flood the limiter.
      { name: "login-ip", match: (p) => p === "/v1/auth/login" || p === "/v1/auth/email-login",
        limit: c.loginPerMinute * 3, windowMs: MINUTE, key: (ip) => ip },
      { name: "admin-login-ip", match: (p) => p === "/v1/admin/auth/login",
        limit: c.adminLoginPerMinute * 3, windowMs: MINUTE, key: (ip) => ip },
      { name: "pay-ip", match: (p) => /^\/v1\/payment-links\/[^/]+\/pay$/.test(p),
        limit: c.payPerMinute * 5, windowMs: MINUTE, key: (ip) => ip },
      { name: "login", match: (p) => p === "/v1/auth/login" || p === "/v1/auth/email-login",
        limit: c.loginPerMinute, windowMs: MINUTE, key: (ip, b) => emailKey(ip, b) },
      { name: "otp", match: (p) => p === "/v1/auth/otp/verify" || p === "/v1/auth/otp/resend",
        limit: c.otpPerMinute, windowMs: MINUTE, key: (ip) => ip },
      { name: "admin-login", match: (p) => p === "/v1/admin/auth/login",
        limit: c.adminLoginPerMinute, windowMs: MINUTE, key: (ip, b) => emailKey(ip, b) },
      { name: "admin-otp", match: (p) => p === "/v1/admin/auth/otp/verify" || p === "/v1/admin/auth/otp/resend",
        limit: c.otpPerMinute, windowMs: MINUTE, key: (ip) => ip },
      { name: "pay", match: (p) => /^\/v1\/payment-links\/[^/]+\/pay$/.test(p),
        limit: c.payPerMinute, windowMs: MINUTE, key: (ip, _b, p) => `${ip}|${p}` },
      { name: "signup", match: (p) => p === "/v1/merchants",
        limit: c.signupPerHour, windowMs: HOUR, key: (ip) => ip },
      // Staff asking to join a company by its ID, and admins redeeming an
      // invitation token: both are guessable-input endpoints, so keep them tight.
      { name: "company-join", match: (p) => p === "/v1/company-join",
        limit: c.signupPerHour, windowMs: HOUR, key: (ip) => ip },
      { name: "accept-invite", match: (p) => p === "/v1/admin/auth/accept-invite",
        limit: c.signupPerHour, windowMs: HOUR, key: (ip) => ip },
    ],
  };
}

/** Registers the app-level limiter hook. No-op when disabled. */
export function registerRateLimits(app: FastifyInstance, config: Config): void {
  const c = resolveRateLimitConfig(config);
  if (!c.enabled) return;
  const rules = buildRules(c);
  const limiter = new FixedWindowLimiter();
  // preHandler: runs after body parsing (needed for the email key) but before
  // the route handler, so no argon2 work happens for a limited request.
  app.addHook("preHandler", async (request, reply) => {
    const list = rules[request.method];
    if (!list) return;
    let path = canonicalPath(request.url.split("?")[0] ?? "");
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    // Every matching rule counts the request (the per-address budget and the per-target one).
    for (const rule of list.filter((r) => r.match(path))) {
      const retryAfter = limiter.hit(`${rule.name}:${rule.key(request.ip, body, path)}`, rule.limit, rule.windowMs);
      if (retryAfter !== null) {
        reply.header("Retry-After", String(retryAfter));
        throw new TooManyRequestsError("rate_limited", "Too many requests. Please try again later.");
      }
    }
  });
}
