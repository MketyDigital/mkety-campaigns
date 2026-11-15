import assert from "node:assert/strict";
import test from "node:test";
import { resolveVerifiedOperatorEmail } from "./operator-auth.js";

test("Ops OIDC accepts a verified email from the signed ID token", () => {
  assert.equal(resolveVerifiedOperatorEmail({ email: "  Operator@Mkety.com ", email_verified: true }), "operator@mkety.com");
});

test("Ops OIDC accepts verified email from UserInfo when the ID token omits it", () => {
  assert.equal(resolveVerifiedOperatorEmail({}, { email: "Operator@Mkety.com", email_verified: true }), "operator@mkety.com");
});

test("Ops OIDC keeps the ID token email and uses UserInfo to confirm verification", () => {
  assert.equal(
    resolveVerifiedOperatorEmail(
      { email: "Operator@Mkety.com", email_verified: false },
      { email: "different@mkety.com", email_verified: true },
    ),
    "operator@mkety.com",
  );
});

test("Ops OIDC rejects missing or unverified email", () => {
  assert.throws(() => resolveVerifiedOperatorEmail({ email: "operator@mkety.com" }), /operator_email_unverified/);
  assert.throws(() => resolveVerifiedOperatorEmail({}, { email: "operator@mkety.com" }), /operator_email_unverified/);
  assert.throws(() => resolveVerifiedOperatorEmail({}, { email_verified: true }), /operator_email_not_allowed/);
});
