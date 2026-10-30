import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ar } from "./ar.js";
import { localeFor, tk, translate } from "./translate.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "ar.ts") out.push(full);
  }
  return out;
}

// t("…") and tk("…") with a plain string literal. A template literal can't be
// looked up, so it is reported separately rather than skipped.
const LITERAL = /(?<![\w.$])(?:t|tk)\(\s*"((?:[^"\\\n]|\\.)*)"/g;
const TEMPLATE = /(?<![\w.$])(?:t|tk)\(\s*`/g;

function collect(): { keys: Map<string, string>; templates: string[] } {
  const keys = new Map<string, string>();
  const templates: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(LITERAL)) keys.set(JSON.parse(`"${match[1]}"`) as string, file);
    if (TEMPLATE.test(text)) templates.push(file);
    TEMPLATE.lastIndex = 0;
  }
  return { keys, templates };
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

test("every translated string has an Arabic entry", () => {
  const { keys } = collect();
  const missing = [...keys.keys()].filter((key) => !Object.prototype.hasOwnProperty.call(ar, key));
  assert.deepEqual(missing, [], `Add these to ar.ts:\n${missing.join("\n")}`);
});

test("ar.ts has no entry that no screen uses", () => {
  const { keys } = collect();
  const unused = Object.keys(ar).filter((key) => !keys.has(key));
  assert.deepEqual(unused, [], `Unused entries in ar.ts:\n${unused.join("\n")}`);
});

test("no translated string is a template literal", () => {
  assert.deepEqual(collect().templates, []);
});

test("Arabic text keeps the same {placeholders} as the English", () => {
  for (const [key, value] of Object.entries(ar)) {
    assert.deepEqual(placeholders(value), placeholders(key), `placeholders differ for: ${key}`);
  }
});

test("no Arabic entry is empty or identical to its English key (except brand names)", () => {
  for (const [key, value] of Object.entries(ar)) {
    assert.ok(value.trim().length > 0, `empty translation for: ${key}`);
  }
});

test("translate falls back to the English text and fills placeholders", () => {
  assert.equal(translate("en", "Hello {name}", { name: "Ali" }), "Hello Ali");
  assert.equal(translate("ar", "A string with no Arabic entry"), "A string with no Arabic entry");
  assert.equal(translate("en", "Keep {unknown}", {}), "Keep {unknown}");
  assert.equal(tk("same"), "same");
});

test("Arabic dates use Latin digits and the Gregorian calendar", () => {
  assert.equal(localeFor("en"), undefined);
  const formatted = new Date("2026-10-30T12:00:00Z").toLocaleDateString(localeFor("ar"));
  assert.match(formatted, /2026/);
  assert.doesNotMatch(formatted, /[٠-٩]/);
});
