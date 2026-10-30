import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeFileName } from "./kyc.js";

test("sanitizeFileName strips paths, quotes and CR/LF", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("C:\\x\\id.pdf"), "id.pdf");
  assert.equal(sanitizeFileName('a"\r\nSet-Cookie: x.pdf'), "a___Set-Cookie: x.pdf");
  assert.equal(sanitizeFileName(".."), "document");
});
