import assert from "node:assert/strict";
import test from "node:test";
import { buildQr, QR_QUIET_ZONE, qrPath, qrViewSize } from "./qr.js";

const URL_SAMPLE = "https://app.143-110-252-107.sslip.io/pay/3f9c2a7e1b8d4c6f9a0e5d7b2c1f8a34";

test("buildQr produces a valid QR size (17 + 4 * version)", () => {
  const qr = buildQr(URL_SAMPLE);
  assert.equal((qr.size - 17) % 4, 0);
  assert.ok(qr.size >= 21 && qr.size <= 177);
});

test("buildQr is deterministic for the same input and differs for another", () => {
  const rows = (text: string) => {
    const qr = buildQr(text);
    return qrPath(qr);
  };
  assert.equal(rows(URL_SAMPLE), rows(URL_SAMPLE));
  assert.notEqual(rows(URL_SAMPLE), rows(`${URL_SAMPLE}x`));
});

test("buildQr draws the three finder patterns", () => {
  const qr = buildQr(URL_SAMPLE);
  const corners: Array<[number, number]> = [
    [0, 0],
    [0, qr.size - 7],
    [qr.size - 7, 0],
  ];
  for (const [row, col] of corners) {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(qr.isDark(row + r, col + c), ring || core, `finder at ${row},${col} cell ${r},${c}`);
      }
    }
  }
});

test("qrPath reproduces exactly the dark modules, offset by the quiet zone", () => {
  const qr = buildQr(URL_SAMPLE);
  const drawn = new Set<string>();
  for (const [, x, y, w] of qrPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i += 1) drawn.add(`${Number(y)},${Number(x) + i}`);
  }
  let dark = 0;
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      const expected = qr.isDark(row, col);
      if (expected) dark += 1;
      assert.equal(drawn.has(`${row + QR_QUIET_ZONE},${col + QR_QUIET_ZONE}`), expected);
    }
  }
  assert.equal(drawn.size, dark);
});

test("qrViewSize adds a four-module quiet zone on each side", () => {
  const qr = buildQr(URL_SAMPLE);
  assert.equal(qrViewSize(qr), qr.size + 8);
});

test("buildQr rejects empty text", () => {
  assert.throws(() => buildQr(""));
});
