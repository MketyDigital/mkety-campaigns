import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { PostgresDomainRepository } from "./domains/repository.js";
import { createOptionalTenantDomainService } from "./domains/runtime.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : undefined;
const auth = pool && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL
  ? createAuth(pool, process.env)
  : undefined;
const domains = pool
  ? createOptionalTenantDomainService(new PostgresDomainRepository(pool), process.env)
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
} : undefined, domains);

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`MKETY Campaigns listening on http://${info.address}:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await pool?.end();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
