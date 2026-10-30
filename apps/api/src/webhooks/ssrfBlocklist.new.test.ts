/** Pure unit tests (no DB): SSRF blocklist, registration-time DNS vetting, transport guard. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWebhookHostResolvesPublic, isPrivateWebhookHost } from "./create.js";
import { createFetchTransport } from "./transport.js";

const blocked = [
  "0.1.2.3", "10.1.1.1", "127.0.0.1", "100.64.0.1", "100.127.255.254", "169.254.169.254", "172.16.0.1",
  "172.31.255.255", "192.0.0.8", "192.168.0.1", "198.18.0.1", "198.19.255.255", "224.0.0.1", "240.0.0.1",
  "255.255.255.255",
  "::", "::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "fc00::1", "fd12::1", "fe80::1", "febf::1", "ff02::1",
  "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::1",
  "2002:7f00:1::1", "2002:a9fe:a9fe::", "2002:c0a8:101::1", "2001:db8::1",
];
const allowed = ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "192.0.1.1",
  "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::1", "::ffff:8.8.8.8", "2001:4860:4860::8888"];

for (const h of blocked) test(`blocks ${h}`, () => assert.equal(isPrivateWebhookHost(h), true));
for (const h of allowed) test(`allows ${h}`, () => assert.equal(isPrivateWebhookHost(h), false));

test("registration rejects a hostname resolving to a private address (production)", async () => {
  await assert.rejects(
    assertWebhookHostResolvesPublic("https://evil.example/h", { nodeEnv: "production" }, async () => ["8.8.8.8", "10.0.0.5"]),
    /invalid_url/,
  );
  await assert.rejects(
    assertWebhookHostResolvesPublic("https://evil.example/h", { nodeEnv: "production" }, async () => ["64:ff9b::7f00:1"]),
  );
});

test("registration accepts public resolution, tolerates DNS failure, and skips outside production", async () => {
  await assertWebhookHostResolvesPublic("https://ok.example/h", { nodeEnv: "production" }, async () => ["8.8.8.8"]);
  await assertWebhookHostResolvesPublic("https://nx.example/h", { nodeEnv: "production" }, async () => {
    throw new Error("ENOTFOUND");
  });
  await assertWebhookHostResolvesPublic("https://evil.example/h", { nodeEnv: "test" }, async () => ["10.0.0.5"]);
});

test("production transport refuses private literal targets without connecting", async () => {
  const t = createFetchTransport({ nodeEnv: "production" });
  for (const url of ["https://127.0.0.1/", "https://[64:ff9b::7f00:1]/", "https://localhost/"]) {
    const r = await t({ url, headers: {}, body: "{}", timeoutMs: 1000 });
    assert.equal(r.statusCode, null);
    assert.match(r.errorMessage ?? "", /private address/);
  }
});
