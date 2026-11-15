import assert from "node:assert/strict";
import test from "node:test";
import { hasMfaAssurance } from "./operator-auth.js";

test("Ops OIDC requires the issuer's explicit MFA authentication method", () => {
  assert.equal(hasMfaAssurance(["pwd", "mfa", "otp"]), true);
  assert.equal(hasMfaAssurance(["pwd"]), false);
  assert.equal(hasMfaAssurance([]), false);
  assert.equal(hasMfaAssurance("pwd mfa"), false);
  assert.equal(hasMfaAssurance(undefined), false);
});
