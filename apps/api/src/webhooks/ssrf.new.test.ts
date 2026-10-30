import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWebhookUrl } from "./create.js";

const cfg = { nodeEnv: "production" } as const;
for (const u of [
  "https://localhost/x", "https://127.0.0.1/", "https://10.0.0.5/", "https://192.168.1.1/",
  "https://172.16.0.1/", "https://169.254.169.254/latest", "https://0.0.0.0/", "https://2130706433/",
  "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:169.254.169.254]/", "https://[fe80::1]/",
  "https://[fd00::1]/", "https://foo.internal/", "https://printer.local/", "https://a.localhost/",
]) {
  test(`rejects ${u}`, () => assert.throws(() => validateWebhookUrl(u, cfg)));
}
for (const u of ["https://example.com/hook", "https://8.8.8.8/", "https://[2606:4700::1111]/"]) {
  test(`accepts ${u}`, () => assert.doesNotThrow(() => validateWebhookUrl(u, cfg)));
}
