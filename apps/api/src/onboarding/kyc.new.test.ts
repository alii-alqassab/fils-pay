import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { recordKycDocument } from "./kyc.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

for (const documentType of ["commercial_registration", "bank_letter"] as const) {
  test(`recordKycDocument rejects a JPEG named .pdf for ${documentType}`, async () => {
    await assert.rejects(
      recordKycDocument({} as Pool, {} as Config, {
        merchantId: "m1",
        documentType,
        fileName: "certificate.pdf",
        buffer: jpeg,
        uploadedBy: "u1",
      }),
      { code: "document_must_be_pdf", statusCode: 422 },
    );
  });
}
