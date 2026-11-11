import assert from "node:assert/strict";
import test from "node:test";
import { checkReleaseEnvironment } from "./release-preflight.mjs";

const configured = {
  DATABASE_URL: "postgres://user:hidden@postgres.internal:5432/mkety_campaigns",
  BETTER_AUTH_URL: "https://campaign.mkety.com",
  BETTER_AUTH_SECRET: "n9Fa7dq1HyH2pJ7s6eN0V3wX1L5Rk8Q4yT",
  MKETY_OPS_AUTH_ISSUER: "https://auth.mkety.com",
  MKETY_OPS_AUTH_CLIENT_ID: "campaigns-ops-client",
  MKETY_OPS_ALLOWED_EMAIL: "hello@mkety.com",
  MKETY_OPS_AUTH_CALLBACK_URL: "https://campaign.mkety.com/api/ops/auth/callback",
  EMAIL_CAMPAIGN_SEND_ENABLED: "false",
  EMAIL_TEST_SEND_ENABLED: "false",
  SMS_ENABLED: "false",
  OCI_BACKUP_ENABLED: "false",
  EMAIL_CAMPAIGN_MAX_RECIPIENTS: "1",
  EMAIL_CAMPAIGN_DAILY_RECIPIENT_LIMIT: "100",
};

test("release preflight accepts a dedicated database and all safety gates off", () => {
  assert.deepEqual(checkReleaseEnvironment(configured), []);
});

test("release preflight rejects shared or non-Postgres database targets", () => {
  assert.match(checkReleaseEnvironment({ ...configured, DATABASE_URL: "postgres://admin:private@db.internal/other_app" }).join(" "), /dedicated mkety_campaigns/i);
  assert.match(checkReleaseEnvironment({ ...configured, DATABASE_URL: "sqlite:///mkety_campaigns" }).join(" "), /PostgreSQL/i);
});

test("release preflight enforces HTTPS origin and strong non-placeholder auth secrets", () => {
  assert.match(checkReleaseEnvironment({ ...configured, BETTER_AUTH_URL: "http://campaign.mkety.com" }).join(" "), /clean HTTPS origin/i);
  assert.match(checkReleaseEnvironment({ ...configured, BETTER_AUTH_URL: "https://evil.example" }).join(" "), /RELEASE_EXPECTED_ORIGIN/i);
  assert.match(checkReleaseEnvironment({ ...configured, BETTER_AUTH_SECRET: "short" }).join(" "), /BETTER_AUTH_SECRET/i);
  assert.match(checkReleaseEnvironment({ ...configured, BETTER_AUTH_SECRET: "a".repeat(40) }).join(" "), /BETTER_AUTH_SECRET/i);
});

test("release preflight requires valid MKETY Ops OIDC configuration", () => {
  assert.match(checkReleaseEnvironment({ ...configured, MKETY_OPS_AUTH_ISSUER: "http://auth.mkety.com" }).join(" "), /MKETY_OPS_AUTH_ISSUER/i);
  assert.match(checkReleaseEnvironment({ ...configured, MKETY_OPS_AUTH_CLIENT_ID: "" }).join(" "), /MKETY_OPS_AUTH_CLIENT_ID/i);
  assert.match(checkReleaseEnvironment({ ...configured, MKETY_OPS_ALLOWED_EMAIL: "not-email" }).join(" "), /MKETY_OPS_ALLOWED_EMAIL/i);
  assert.match(checkReleaseEnvironment({ ...configured, MKETY_OPS_AUTH_CALLBACK_URL: "https://campaign.mkety.com/wrong" }).join(" "), /MKETY_OPS_AUTH_CALLBACK_URL/i);
});

test("release preflight rejects enabled or absent delivery gates", () => {
  for (const key of ["EMAIL_CAMPAIGN_SEND_ENABLED", "EMAIL_TEST_SEND_ENABLED", "SMS_ENABLED", "OCI_BACKUP_ENABLED"]) {
    assert.match(checkReleaseEnvironment({ ...configured, [key]: "true" }).join(" "), new RegExp(key));
    assert.match(checkReleaseEnvironment({ ...configured, [key]: undefined }).join(" "), new RegExp(key));
  }
});

test("release preflight checks queue ceilings and never echoes supplied secrets", () => {
  const secret = "secret-sentinel-very-long-and-unmistakable";
  const checks = checkReleaseEnvironment({
    ...configured, BETTER_AUTH_SECRET: secret,
    DATABASE_URL: "postgres://user:password-sentinel@db.example/another_database",
    EMAIL_CAMPAIGN_MAX_RECIPIENTS: "1001",
    EMAIL_CAMPAIGN_DAILY_RECIPIENT_LIMIT: "0",
  });
  assert.ok(checks.some((line) => line.includes("EMAIL_CAMPAIGN_MAX_RECIPIENTS")));
  assert.ok(checks.some((line) => line.includes("EMAIL_CAMPAIGN_DAILY_RECIPIENT_LIMIT")));
  assert.doesNotMatch(checks.join(" "), /secret-sentinel|password-sentinel/);
});
