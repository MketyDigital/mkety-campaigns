import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { getPostgresPoolOptions } from "../scripts/postgres-pool-options.mjs";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { PostgresDomainRepository } from "./domains/repository.js";
import { createOptionalEmailDomainProvider } from "./domains/runtime.js";
import { createTenantDomainService } from "./domains/service.js";
import { PostgresSenderRepository, createTenantSenderService } from "./domains/senders.js";
import { PostgresCampaignWorkspace } from "./campaigns/repository.js";
import { PostgresCampaignDispatchRepository } from "./campaigns/delivery-repository.js";
import { createEmailCampaignWorker } from "./campaigns/delivery.js";
import { PostgresOperationsService } from "./ops/service.js";
import { createOperatorAuth } from "./ops/operator-auth.js";
import { createOptionalEmailProviders, createSelectedEmailProvider } from "./email/providers.js";
import { createEmailTestSender } from "./email/test-send.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const poolOptions = getPostgresPoolOptions(process.env, 5);
const pool = poolOptions ? new Pool(poolOptions) : undefined;
let databaseConnectionErrorLogged = false;
const knownDatabaseErrorCodes = new Set(["ECONNREFUSED","ECONNRESET","ETIMEDOUT","ENOTFOUND","EAI_AGAIN","EHOSTUNREACH","EADDRNOTAVAIL","EPIPE","UNABLE_TO_VERIFY_LEAF_SIGNATURE","SELF_SIGNED_CERT_IN_CHAIN","DEPTH_ZERO_SELF_SIGNED_CERT","CERT_HAS_EXPIRED","ERR_TLS_CERT_ALTNAME_INVALID","28P01","3D000","42501"]);
const logDatabaseConnectionFailure = (error: unknown) => {
  if (databaseConnectionErrorLogged) return;
  databaseConnectionErrorLogged = true;
  const detail = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
  const errorType = typeof detail.name === "string" && /^[A-Za-z0-9]{1,40}$/.test(detail.name) ? detail.name : "unclassified";
  const errorCode = typeof detail.code === "string" && knownDatabaseErrorCodes.has(detail.code) ? detail.code : "unclassified";
  console.error("Campaigns database connection failed:", JSON.stringify({ errorType, errorCode }));
};
if (pool) {
  let connected = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      connected = true;
      break;
    } catch (error) {
      logDatabaseConnectionFailure(error);
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (!connected) throw new Error("Campaigns PostgreSQL startup preflight failed after bounded retries.");
}
const auth = pool && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL
  ? createAuth(pool, process.env)
  : undefined;
const domainRepository = pool ? new PostgresDomainRepository(pool) : undefined;
const emailProviderName = process.env.EMAIL_PROVIDER ?? "acs-email";
const emailProviders = createOptionalEmailProviders(process.env);
const emailProvider = createSelectedEmailProvider(process.env);
const emailDomainProvider = createOptionalEmailDomainProvider(process.env);
const domains = domainRepository && emailDomainProvider ? createTenantDomainService(domainRepository, emailDomainProvider, emailProviderName as "acs-email" | "oci-email-delivery") : undefined;
const senders = domainRepository && pool && emailDomainProvider
  ? createTenantSenderService(domainRepository, new PostgresSenderRepository(pool), emailDomainProvider, emailProviderName as "acs-email" | "oci-email-delivery")
  : undefined;
const emailTestSender = process.env.EMAIL_TEST_SEND_ENABLED === "true"
  ? pool && emailProvider
    ? createEmailTestSender(new PostgresSenderRepository(pool), emailProvider)
    : (() => { throw new Error("Email test send requires a configured EMAIL_PROVIDER"); })()
  : undefined;
const workspace = pool ? new PostgresCampaignWorkspace(pool) : undefined;
const campaignDispatchEnabled = process.env.EMAIL_CAMPAIGN_SEND_ENABLED === "true";
const campaignRecipientLimit = Number(process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS ?? 100);
const dailyRecipientLimit = Number(process.env.EMAIL_CAMPAIGN_DAILY_RECIPIENT_LIMIT ?? 1000);
const providerMinIntervalMs = Number(process.env.EMAIL_PROVIDER_MIN_INTERVAL_MS ?? 1000);
const campaignDispatch = pool && process.env.BETTER_AUTH_URL
  ? new PostgresCampaignDispatchRepository(pool, process.env.BETTER_AUTH_URL, dailyRecipientLimit, providerMinIntervalMs)
  : undefined;
if (campaignDispatchEnabled && (!pool || !process.env.BETTER_AUTH_URL || !emailProvider)) {
  throw new Error("Campaign sending requires DATABASE_URL, BETTER_AUTH_URL, and a configured EMAIL_PROVIDER");
}
const campaignWorker = campaignDispatchEnabled && campaignDispatch && emailProvider
  ? createEmailCampaignWorker(campaignDispatch, emailProviders, true)
  : undefined;
const operations = pool && process.env.BETTER_AUTH_URL
  ? new PostgresOperationsService(pool, process.env.BETTER_AUTH_URL)
  : undefined;
const operatorAuth = pool ? createOperatorAuth(pool, process.env) : undefined;
const app = createApp(async () => {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    logDatabaseConnectionFailure(error);
    return false;
  }
}, auth && pool ? {
  trustedOrigins: process.env.BETTER_AUTH_URL ? [new URL(process.env.BETTER_AUTH_URL).origin] : [],
  auth: {
    handler: (request) => auth.handler(request),
    getSession: async (headers) => auth.api.getSession({ headers }) as Promise<import("./app.js").AuthSession | null>,
  },
  resolveTenantSeat: async (userId, sessionCreatedAt) => {
    if (!pool) return null;
    const result = await pool.query<{ tenant_id: string }>(
      `SELECT s.tenant_id
         FROM tenant_seats s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN users u ON u.id = s.user_id
        WHERE s.user_id = $1 AND s.status = 'active' AND t.status = 'approved'
          AND u.mfa_enrolled_at IS NOT NULL AND $2::timestamptz >= u.mfa_enrolled_at
        LIMIT 1`,
      [userId, sessionCreatedAt],
    );
    return result.rows[0]?.tenant_id ?? null;
  },
  operatorAuth,
  resolveOpsAdmin: async (userId, sessionCreatedAt) => {
    const result = await pool.query<{ allowed: boolean }>(
      `SELECT TRUE AS allowed FROM users
        WHERE id = $1 AND role = 'ops' AND two_factor_enabled = TRUE
          AND mfa_enrolled_at IS NOT NULL AND $2::timestamptz >= mfa_enrolled_at
        LIMIT 1`, [userId, sessionCreatedAt]);
    return Boolean(result.rows[0]?.allowed);
  },
} : undefined, domains, workspace, operations, senders, emailTestSender, campaignDispatch, campaignDispatchEnabled, campaignRecipientLimit);

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`MKETY Campaigns listening on http://${info.address}:${info.port}`);
});

let campaignWorkerBusy = false;
const campaignWorkerTimer = campaignWorker ? setInterval(() => {
  if (campaignWorkerBusy) return;
  campaignWorkerBusy = true;
  void campaignWorker.processOne().catch(() => {
    console.error("Campaign delivery worker iteration failed; check database and provider connectivity.");
  }).finally(() => { campaignWorkerBusy = false; });
}, 3000) : undefined;
campaignWorkerTimer?.unref();

const shutdown = async () => {
  if (campaignWorkerTimer) clearInterval(campaignWorkerTimer);
  server.close();
  await pool?.end();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
