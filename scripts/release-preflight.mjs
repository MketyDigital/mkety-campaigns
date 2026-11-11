import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DISABLED_FLAGS = ["EMAIL_CAMPAIGN_SEND_ENABLED", "EMAIL_TEST_SEND_ENABLED", "SMS_ENABLED", "OCI_BACKUP_ENABLED"];

/**
 * Read-only configuration preflight. Never print environment values or secrets.
 * It does not connect to a database or inspect the remote deployment.
 */
export function checkReleaseEnvironment(env) {
  const errors = [];
  let database;
  try {
    database = new URL(env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(database.protocol)) {
      errors.push("DATABASE_URL must use PostgreSQL");
    } else if (decodeURIComponent(database.pathname) !== "/mkety_campaigns") {
      errors.push("DATABASE_URL must target the dedicated mkety_campaigns database");
    }
    if (!database.hostname) errors.push("DATABASE_URL must include a database host");
  } catch {
    errors.push("DATABASE_URL must be a valid PostgreSQL URL");
  }
  let auth;
  try {
    auth = new URL(env.BETTER_AUTH_URL ?? "");
    if (auth.protocol !== "https:" || auth.username || auth.password || auth.search || auth.hash || auth.pathname !== "/") {
      errors.push("BETTER_AUTH_URL must be a clean HTTPS origin");
    }
    const expected = env.RELEASE_EXPECTED_ORIGIN || "https://campaign.mkety.com";
    if (auth.origin !== expected) errors.push("BETTER_AUTH_URL does not match RELEASE_EXPECTED_ORIGIN");
  } catch {
    errors.push("BETTER_AUTH_URL must be a valid HTTPS URL");
  }
  const oidcIssuer = env.MKETY_OPS_AUTH_ISSUER || "";
  const oidcClientId = env.MKETY_OPS_AUTH_CLIENT_ID || "";
  const oidcEmail = env.MKETY_OPS_ALLOWED_EMAIL || "";
  const oidcCallback = env.MKETY_OPS_AUTH_CALLBACK_URL || "";
  try {
    const issuer = new URL(oidcIssuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) errors.push("MKETY_OPS_AUTH_ISSUER must be a clean HTTPS issuer URL");
  } catch { errors.push("MKETY_OPS_AUTH_ISSUER must be a valid HTTPS URL"); }
  if (!oidcClientId.trim()) errors.push("MKETY_OPS_AUTH_CLIENT_ID is required");
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(oidcEmail.trim())) errors.push("MKETY_OPS_ALLOWED_EMAIL must be a single operator email");
  try {
    const callback = new URL(oidcCallback);
    const expected = env.RELEASE_EXPECTED_ORIGIN || "https://campaign.mkety.com";
    if (callback.origin !== expected || callback.pathname !== "/api/ops/auth/callback" || callback.search || callback.hash) errors.push("MKETY_OPS_AUTH_CALLBACK_URL must match the Campaigns OIDC callback");
  } catch { errors.push("MKETY_OPS_AUTH_CALLBACK_URL must be a valid HTTPS URL"); }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || /^(.)\1+$/.test(secret) || /^(change-me|placeholder|example)/i.test(secret)) {
    errors.push("BETTER_AUTH_SECRET must be a non-placeholder value of at least 32 characters");
  }
  for (const key of DISABLED_FLAGS) {
    if (env[key] !== "false") errors.push(`${key} must be explicitly false before release`);
  }
  for (const [key, defaultValue, ceiling] of [
    ["EMAIL_CAMPAIGN_MAX_RECIPIENTS", 100, 1000],
    ["EMAIL_CAMPAIGN_DAILY_RECIPIENT_LIMIT", 1000, 100000],
  ]) {
    const raw = env[key] ?? String(defaultValue);
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(number) || number < 1 || number > ceiling) {
      errors.push(`${key} must be an integer from 1 to ${ceiling}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkReleaseEnvironment(process.env);
  if (problems.length) {
    for (const problem of problems) console.error(`Preflight failed: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("Configuration preflight passed. Manual deployment, DB isolation, DNS/TLS, provider, and restore checks are still required.");
  }
}
