import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { errorHandler } from "./errorHandler.js";

test("a pool-exhaustion error is a 503 service_busy with Retry-After, not a 500", async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get("/busy", async () => {
    throw new Error("timeout exceeded when trying to connect");
  });
  app.get("/boom", async () => {
    throw new Error("something else");
  });
  const busy = await app.inject({ method: "GET", url: "/busy" });
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers["retry-after"], "1");
  assert.equal((busy.json() as { error: string }).error, "service_busy");
  assert.equal((await app.inject({ method: "GET", url: "/boom" })).statusCode, 500);
  await app.close();
});
