import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

const FRAMEWORK_ERROR_CODES: Record<number, string> = {
  400: "invalid_request",
  404: "not_found",
  405: "method_not_allowed",
  408: "request_timeout",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "too_many_requests",
};

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Framework-raised client errors (malformed JSON, unsupported media type,
  // payload too large, ...) carry their own 4xx statusCode.
  const status = fastifyErr.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    const code = FRAMEWORK_ERROR_CODES[status] ?? "bad_request";
    reply.code(status).send({ error: code });
    return;
  }

  // The database pool is exhausted (every connection busy for longer than the connect
  // timeout). That is overload, not a bug: tell the client to retry shortly instead of
  // answering 500. Mutating calls stay safe to retry because they carry Idempotency-Keys.
  if (err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message)) {
    request.log.warn({ occurredOn: formatIsoDate(new Date()) }, "database pool exhausted");
    reply.header("Retry-After", "1").code(503).send({ error: "service_busy", message: "The service is busy, retry shortly." });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}
