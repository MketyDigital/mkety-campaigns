import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { PostgresDomainRepository } from "./domains/repository.js";
import { createOptionalAzureDomainProvider } from "./domains/runtime.js";
import { createTenantDomainService } from "./domains/service.js";
import { PostgresSenderRepository, createTenantSenderService } from "./domains/senders.js";
import { PostgresCampaignWorkspace } from "./campaigns/repository.js";
import { PostgresCampaignDispatchRepository } from "./campaigns/delivery-repository.js";
import { createEmailCampaignWorker } from "./campaigns/delivery.js";
import { PostgresOperationsService } from "./ops/service.js";
import { createAcsEmailProvider } from "./email/providers.js";
import { createEmailTestSender } from "./email/test-send.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : undefined;
const auth = pool && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL
  ? createAuth(pool, process.env)
  : undefined;
const domainRepository = pool ? new PostgresDomainRepository(pool) : undefined;
const azureDomainProvider = createOptionalAzureDomainProvider(process.env);
const domains = domainRepository && azureDomainProvider ? createTenantDomainService(domainRepository, azureDomainProvider) : undefined;
const senders = domainRepository && pool && azureDomainProvider
  ? createTenantSenderService(domainRepository, new PostgresSenderRepository(pool), azureDomainProvider)
  : undefined;
const emailTestSender = process.env.EMAIL_TEST_SEND_ENABLED === "true"
  ? pool && process.env.EMAIL_PROVIDER === "acs-email" && process.env.ACS_EMAIL_CONNECTION_STRING
    ? createEmailTestSender(new PostgresSenderRepository(pool), createAcsEmailProvider({ connectionString: process.env.ACS_EMAIL_CONNECTION_STRING }))
    : (() => { throw new Error("Email test send requires EMAIL_PROVIDER=acs-email and ACS_EMAIL_CONNECTION_STRING"); })()
  : undefined;
const workspace = pool ? new PostgresCampaignWorkspace(pool) : undefined;
const campaignDispatchEnabled = process.env.EMAIL_CAMPAIGN_SEND_ENABLED === "true";
const campaignRecipientLimit = Number(process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS ?? 100);
const campaignDispatch = campaignDispatchEnabled && pool && process.env.BETTER_AUTH_URL
  ? new PostgresCampaignDispatchRepository(pool, process.env.BETTER_AUTH_URL)
  : undefined;
if (campaignDispatchEnabled && (!pool || !process.env.BETTER_AUTH_URL || process.env.EMAIL_PROVIDER !== "acs-email" || !process.env.ACS_EMAIL_CONNECTION_STRING)) {
  throw new Error("Campaign sending requires DATABASE_URL, BETTER_AUTH_URL, EMAIL_PROVIDER=acs-email, and ACS_EMAIL_CONNECTION_STRING");
}
const campaignWorker = campaignDispatchEnabled && campaignDispatch && process.env.ACS_EMAIL_CONNECTION_STRING
  ? createEmailCampaignWorker(campaignDispatch, createAcsEmailProvider({ connectionString: process.env.ACS_EMAIL_CONNECTION_STRING }), true)
  : undefined;
const operations = pool && process.env.BETTER_AUTH_URL
  ? new PostgresOperationsService(pool, process.env.BETTER_AUTH_URL)
  : undefined;
const app = createApp(async () => {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
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
