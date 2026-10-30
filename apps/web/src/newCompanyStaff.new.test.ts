import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompanyCode } from "./utils/companyCode.js";
import { loginErrorMessage } from "./utils/loginErrors.js";

test("normalizeCompanyCode accepts typed variations and rejects look-alike characters", () => {
  assert.equal(normalizeCompanyCode("fp-7k3m-9qxa"), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("  FP7K3M9QXA "), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("7K3M 9QXA"), "FP-7K3M-9QXA");
  assert.equal(normalizeCompanyCode("FP-7K3M-9QX0"), null);
  assert.equal(normalizeCompanyCode("FP-7K3M"), null);
  assert.equal(normalizeCompanyCode(""), null);
});

test("loginErrorMessage gives friendly text for pending and disabled accounts, null otherwise", () => {
  assert.match(loginErrorMessage("account_pending_owner_approval", 403)!, /waiting for your company owner/i);
  assert.match(loginErrorMessage("account_disabled", 403)!, /cannot sign in/i);
  assert.match(loginErrorMessage("invalid_credentials", 401)!, /not correct/i);
  assert.equal(loginErrorMessage("something_else", 500), null);
});
