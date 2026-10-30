import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { generateKycThumbnail, MAX_INPUT_PIXELS } from "./kycThumbnail.js";

test("a normal image still gets a JPEG thumbnail", async () => {
  const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#336699" } }).png().toBuffer();
  const t = await generateKycThumbnail(png, "png");
  assert.equal(t?.mimeType, "image/jpeg");
});

test("an image above the pixel budget is refused instead of being decoded", async () => {
  // A small compressed PNG whose declared size is over the limit.
  const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 100;
  const big = await sharp({ create: { width: side, height: side, channels: 3, background: "#000000" } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await assert.rejects(() => generateKycThumbnail(big, "png"));
});

test("several uploads at once all complete (concurrency is capped, not dropped)", async () => {
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#aa5500" } }).png().toBuffer();
  const results = await Promise.all(Array.from({ length: 8 }, () => generateKycThumbnail(png, "png")));
  assert.equal(results.filter((r) => r !== null).length, 8);
});
