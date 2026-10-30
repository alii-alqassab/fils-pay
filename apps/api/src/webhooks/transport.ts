import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import type { Config } from "../config.js";
import { isPrivateWebhookHost } from "./create.js";

/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

// Dispatcher and test-send persist at most 2,000 characters. Leave room for
// four-byte UTF-8 characters while keeping memory use bounded if a receiver
// returns an unexpectedly large body.
const MAX_RESPONSE_BODY_BYTES = 8_000;

/**
 * In production, refuses hostnames resolving to private/loopback/link-local
 * addresses and returns the vetted addresses so the connection can be pinned
 * to them (a second resolution at connect time could return a different,
 * private answer: DNS rebinding). Returns null when no pinning is needed.
 */
async function vetHost(rawUrl: string, allowPrivateHosts: boolean): Promise<string[] | null> {
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (allowPrivateHosts) return null;
  if (isPrivateWebhookHost(hostname)) throw new Error("webhook url resolves to a private address");
  if (isIP(hostname)) return null;
  const addrs = await lookup(hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateWebhookHost(a.address))) {
    throw new Error("webhook url resolves to a private address");
  }
  return addrs.map((a) => a.address);
}

/** A net `lookup` that only ever answers with the already-vetted addresses. */
function pinnedLookup(addresses: string[]) {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void): void => {
    if (options?.all) cb(null, entries);
    else cb(null, entries[0]!.address, entries[0]!.family);
  };
}

/** Sends the POST over node:http(s) so the vetted IP can be pinned while the URL's hostname still drives SNI and Host. */
function post(
  req: WebhookTransportRequest,
  pinned: string[] | null,
  signal: AbortSignal,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const mod = url.protocol === "https:" ? https : http;
    const request = mod.request(
      url,
      {
        method: "POST",
        headers: { ...req.headers, "Content-Length": Buffer.byteLength(req.body) },
        agent: false,
        signal,
        ...(pinned ? { lookup: pinnedLookup(pinned) as never } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({ statusCode: status, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let count = 0;
        const finish = (): void => resolve({ statusCode: status, body: Buffer.concat(chunks).toString("utf8") });
        res.on("data", (chunk: Buffer) => {
          const room = MAX_RESPONSE_BODY_BYTES - count;
          chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
          count += Math.min(chunk.byteLength, room);
          if (count >= MAX_RESPONSE_BODY_BYTES) {
            // Stop the response stream instead of draining an unbounded body.
            res.destroy();
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", (err) => (count >= MAX_RESPONSE_BODY_BYTES ? undefined : reject(err)));
      },
    );
    request.on("error", reject);
    request.end(req.body);
  });
}

/** Real transport: node http(s) with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export function createFetchTransport(
  config: Pick<Config, "nodeEnv"> = { nodeEnv: "test" },
): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // Resolve and vet the host here too (DNS names can point at private IPs),
      // then pin the connection to the vetted addresses.
      // Redirects are never followed: a 3xx is reported as a failure below.
      const pinned = await vetHost(req.url, config.nodeEnv !== "production");
      const response = await post(req, pinned, controller.signal);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        return { statusCode: null, body: "", errorMessage: `redirect not followed (status ${response.statusCode})` };
      }
      return { statusCode: response.statusCode, body: response.body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
