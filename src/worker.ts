import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { D1DomainRepository } from "./domains/repository.js";
import { createOptionalTenantDomainService } from "./domains/runtime.js";

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
  }): Response | Promise<Response> {
    const auth = env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL ? createAuth(env.DB, env) : undefined;
    let domains;
    try {
      domains = createOptionalTenantDomainService(new D1DomainRepository(env.DB), env);
    } catch {
      // Workers have no process startup phase; keep health/auth routes available
      // and leave domain endpoints disabled when Azure settings are incomplete.
      domains = undefined;
    }
    const app = createApp(async () => {
      try {
        await env.DB.prepare("SELECT 1").first();
        return true;
      } catch {
        return false;
      }
    }, auth ? {
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
    } : undefined, domains);
    return app.fetch(request, env);
  },
};
