import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSeedAllowed } from "./guard.js";

const ok = "postgres://u:p@localhost:5432/d";

test("refuses without NODE_ENV=development or SEED_ALLOW=1", () => {
  assert.throws(() => assertSeedAllowed({ NODE_ENV: "test", DATABASE_URL: ok }), /refusing/);
  assert.throws(() => assertSeedAllowed({ NODE_ENV: "production", DATABASE_URL: ok }), /refusing/);
  assert.throws(() => assertSeedAllowed({ DATABASE_URL: ok }), /refusing/);
});

test("allows local hosts", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]", "postgres"]) {
    assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: `postgres://u:p@${h}:5432/d` });
  }
  assertSeedAllowed({ SEED_ALLOW: "1", DATABASE_URL: ok });
});

test("refuses non-local hosts and ?host= overrides", () => {
  assert.throws(
    () => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "postgres://u:p@db.prod.example:5432/d" }),
    /non-local/,
  );
  assert.throws(
    () => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: `${ok}?host=db.prod.example` }),
    /non-local/,
  );
  assert.throws(() => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "not a url" }), /parseable/);
});
