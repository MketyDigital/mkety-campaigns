import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { D1DomainRepository } from "./domains/repository.js";
import { createOptionalAzureDomainProvider } from "./domains/runtime.js";
import { createTenantDomainService } from "./domains/service.js";
import { createTenantSenderService, D1SenderRepository } from "./domains/senders.js";
import { D1CampaignWorkspace } from "./campaigns/repository.js";
import { D1CampaignDispatchRepository } from "./campaigns/delivery-repository.js";
import { createEmailCampaignWorker } from "./campaigns/delivery.js";
import { D1OperationsService } from "./ops/service.js";
import { createAcsEmailProvider } from "./email/providers.js";
import { createEmailTestSender } from "./email/test-send.js";

export default {
  fetch(request: Request, env: {
    DB: D1Database;
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_URL?: string;
    AZURE_ARM_TENANT_ID?: string;
    AZURE_ARM_CLIENT_ID?: string;
    AZURE_ARM_CLIENT_SECRET?: string;
    AZURE_SUBSCRIPTION_ID?: string;
    AZURE_RESOURCE_GROUP?: string;
    AZURE_EMAIL_SERVICE_NAME?: string;
    AZURE_COMMUNICATION_SERVICE_NAME?: string;
    ACS_EMAIL_CONNECTION_STRING?: string;
    EMAIL_PROVIDER?: string;
    EMAIL_TEST_SEND_ENABLED?: string;
    EMAIL_CAMPAIGN_SEND_ENABLED?: string;
    EMAIL_CAMPAIGN_MAX_RECIPIENTS?: string;
  }): Response | Promise<Response> {
    const auth = env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL ? createAuth(env.DB, env) : undefined;
    const domainRepository = new D1DomainRepository(env.DB);
    let azureDomainProvider;
    let domains;
    let senders;
    try {
      azureDomainProvider = createOptionalAzureDomainProvider(env);
      if (azureDomainProvider) {
        domains = createTenantDomainService(domainRepository, azureDomainProvider);
        senders = createTenantSenderService(domainRepository, new D1SenderRepository(env.DB), azureDomainProvider);
      }
    } catch {
      // Workers have no process startup phase; keep health/auth routes available
      // and leave domain endpoints disabled when Azure settings are incomplete.
      domains = undefined;
      senders = undefined;
    }
    const emailTestSender = env.EMAIL_TEST_SEND_ENABLED === "true" && env.EMAIL_PROVIDER === "acs-email" && env.ACS_EMAIL_CONNECTION_STRING
      ? createEmailTestSender(new D1SenderRepository(env.DB), createAcsEmailProvider({ connectionString: env.ACS_EMAIL_CONNECTION_STRING }))
      : undefined;
    const app = createApp(async () => {
      try {
        await env.DB.prepare("SELECT 1").first();
        return true;
      } catch {
        return false;
      }
    }, auth ? {
      trustedOrigins: env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : [],
      auth: {
        handler: (incoming) => auth.handler(incoming),
        getSession: async (headers) => auth.api.getSession({ headers }) as Promise<import("./app.js").AuthSession | null>,
      },
      resolveTenantSeat: async (userId, sessionCreatedAt) => {
        const result = await env.DB.prepare(
          `SELECT s.tenant_id
             FROM tenant_seats s
             JOIN tenants t ON t.id = s.tenant_id
             JOIN users u ON u.id = s.user_id
            WHERE s.user_id = ?1 AND s.status = 'active' AND t.status = 'approved'
              AND u.mfa_enrolled_at IS NOT NULL
              AND datetime(?2) >= datetime(u.mfa_enrolled_at)
            LIMIT 1`,
        ).bind(userId, sessionCreatedAt.toISOString()).first<{ tenant_id: string }>();
        return result?.tenant_id ?? null;
      },
      resolveOpsAdmin: async (userId, sessionCreatedAt) => {
        const result = await env.DB.prepare(
          `SELECT 1 AS allowed FROM users
            WHERE id = ?1 AND role = 'ops' AND two_factor_enabled = 1
              AND mfa_enrolled_at IS NOT NULL AND datetime(?2) >= datetime(mfa_enrolled_at)
            LIMIT 1`,
        ).bind(userId, sessionCreatedAt.toISOString()).first<{ allowed: number }>();
        return result?.allowed === 1;
      },
    } : undefined, domains, new D1CampaignWorkspace(env.DB), env.BETTER_AUTH_URL ? new D1OperationsService(env.DB, env.BETTER_AUTH_URL) : undefined, senders, emailTestSender,
      env.EMAIL_CAMPAIGN_SEND_ENABLED === "true" && env.BETTER_AUTH_URL ? new D1CampaignDispatchRepository(env.DB, env.BETTER_AUTH_URL) : undefined,
      env.EMAIL_CAMPAIGN_SEND_ENABLED === "true", Number(env.EMAIL_CAMPAIGN_MAX_RECIPIENTS ?? 100));
    return app.fetch(request, env);
  },
  scheduled(_event: ScheduledController, env: {
    DB: D1Database;
    BETTER_AUTH_URL?: string;
    ACS_EMAIL_CONNECTION_STRING?: string;
    EMAIL_PROVIDER?: string;
    EMAIL_CAMPAIGN_SEND_ENABLED?: string;
  }, context: ExecutionContext): void {
    if (env.EMAIL_CAMPAIGN_SEND_ENABLED !== "true" || env.EMAIL_PROVIDER !== "acs-email" || !env.ACS_EMAIL_CONNECTION_STRING || !env.BETTER_AUTH_URL) return;
    const repository = new D1CampaignDispatchRepository(env.DB, env.BETTER_AUTH_URL);
    const worker = createEmailCampaignWorker(repository, createAcsEmailProvider({ connectionString: env.ACS_EMAIL_CONNECTION_STRING }), true);
    context.waitUntil(worker.processOne().then(() => undefined));
  },
};
