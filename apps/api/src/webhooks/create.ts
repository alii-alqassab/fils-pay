import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
// https-only plus private-host rejection in production are the SSRF controls.
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  // Local receivers are useful while developing integrations. Production
  // remains restricted to public hosts to prevent SSRF into private networks.
  if (config.nodeEnv === "production" && isPrivateWebhookHost(parsed.hostname)) {
    throw new BadRequestError("invalid_url");
  }
  return parsed;
}

function isPrivateIpv4(a: number, b: number, c = 0): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast / reserved / broadcast
  );
}

/** Expands an IPv6 literal (incl. a trailing dotted IPv4) to 8 16-bit groups, or null. */
function parseIpv6Groups(host: string): number[] | null {
  let h = host.split("%")[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number) as number[];
    h = h.slice(0, dotted.index) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const groups = parts.map((x) => parseInt(x, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): boolean {
  return isPrivateIpv4(hi >> 8, hi & 0xff, lo >> 8);
}

/**
 * True for hostnames that must never be a webhook target: localhost, .local /
 * .internal names, and literal loopback/private/link-local/metadata/reserved IPs
 * (IPv4, IPv6, IPv4-mapped, NAT64 and 6to4 with the embedded IPv4 checked).
 * Also used by transport for resolved addresses.
 */
export function isPrivateWebhookHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const family = isIP(host);
  if (family === 4) {
    const [a, b, c] = host.split(".").map(Number) as [number, number, number];
    return isPrivateIpv4(a, b, c);
  }
  if (family === 6) {
    const g = parseIpv6Groups(host);
    if (!g) return true; // unparseable: fail closed
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
      if (g5 === 0xffff || g5 === 0) return v4FromGroups(g6, g7); // ::ffff:0:0/96 mapped, ::/96 compatible
    }
    // 64:ff9b::/96 NAT64: embedded IPv4 decides; 64:ff9b:1::/48 local-use NAT64 is blocked outright
    if (g0 === 0x64 && g1 === 0xff9b) {
      if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4FromGroups(g6, g7);
      if (g2 === 1) return true;
    }
    if (g0 === 0x2002) return v4FromGroups(g1, g2); // 6to4: embedded IPv4
    if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, documentation
    return (
      (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (g0 & 0xff00) === 0xff00 // multicast
    );
  }
  return false;
}

type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Production-only registration check: a hostname (not just a literal IP) that
 * resolves to any private address is rejected. DNS failure is NOT fatal here
 * (the host may simply not exist yet); the transport re-vets at send time and
 * pins the vetted address, so this is a registration-time early rejection.
 */
export async function assertWebhookHostResolvesPublic(
  rawUrl: string,
  config: Pick<Config, "nodeEnv">,
  resolve: HostResolver = defaultResolver,
): Promise<void> {
  if (config.nodeEnv !== "production") return;
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return;
  let addrs: string[];
  try {
    addrs = await resolve(hostname);
  } catch {
    return;
  }
  if (addrs.some((a) => isPrivateWebhookHost(a))) throw new BadRequestError("invalid_url");
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
  resolve?: HostResolver,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);
  await assertWebhookHostResolvesPublic(input.url, config, resolve);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}
