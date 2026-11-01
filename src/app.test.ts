import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";
import type { TenantDomainService, TenantEmailDomain } from "./domains/service.js";

const activeSession = {
  auth: {
    handler: async () => new Response(null, { status: 404 }),
    getSession: async () => ({ user: { id: "user-1", role: "tenant", twoFactorEnabled: true }, session: { createdAt: new Date() } }),
  },
  resolveTenantSeat: async (userId: string) => userId === "user-1" ? "tenant-authorized" : null,
};

const sampleDomain: TenantEmailDomain = {
  id: "domain-1",
  tenantId: "tenant-authorized",
  domainName: "mail.example.com",
  azureResourceId: "/azure/domain-1",
  provisioningState: "Running",
  verificationRecords: { Domain: { type: "TXT", name: "@", value: "verify", ttl: 3600 } },
  verificationStates: { Domain: { status: "NotStarted" } },
  linked: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function fakeDomainService(overrides: Partial<TenantDomainService> = {}): TenantDomainService {
  return {
    list: async () => [sampleDomain],
    get: async () => sampleDomain,
    create: async () => sampleDomain,
    refresh: async () => sampleDomain,
    retryCreate: async () => sampleDomain,
    verify: async () => sampleDomain,
    ...overrides,
  };
}

test("health endpoint stays available without external services", async () => {
  const response = await createApp().request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("readiness fails closed when the database is unavailable", async () => {
  const response = await createApp(async () => false).request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not_ready" });
});

test("readiness succeeds when the database check passes", async () => {
  const response = await createApp(async () => true).request("/readyz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});

test("domain workspace renders a straightforward onboarding screen", async () => {
  const response = await createApp().request("/app/domains");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Add a sender domain/);
  assert.match(html, /DNS records/);
  assert.match(html, /\/api\/tenant\/domains/);
});

test("home page links to sender-domain setup", async () => {
  const response = await createApp().request("/");
  assert.match(await response.text(), /href="\/app\/domains"/);
});

test("auth endpoints fail closed when auth secrets are not configured", async () => {
  const response = await createApp().request("/api/auth/sign-in/email", { method: "POST" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "auth_not_configured" });
});

test("tenant routes require an authenticated MFA-enabled seat", async () => {
  const app = createApp(async () => true, {
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({ user: { id: "user-1", role: "tenant", twoFactorEnabled: false }, session: { createdAt: new Date() } }),
    },
    resolveTenantSeat: async () => "tenant-1",
  });
  const response = await app.request("/api/tenant/me");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "mfa_required" });
});

test("tenant context comes from the authenticated seat, not a request parameter", async () => {
  const app = createApp(async () => true, {
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({ user: { id: "user-1", role: "tenant", twoFactorEnabled: true }, session: { createdAt: new Date() } }),
    },
    resolveTenantSeat: async (userId) => userId === "user-1" ? "tenant-authorized" : null,
  });
  const response = await app.request("/api/tenant/me?tenantId=tenant-attacker");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tenantId: "tenant-authorized", userId: "user-1" });
});

test("domain API requires the same authenticated MFA-enabled tenant seat", async () => {
  const response = await createApp(async () => true).request("/api/tenant/domains");
  assert.equal(response.status, 503);

  const unauthenticated = await createApp(async () => true, {
    auth: { handler: async () => new Response(), getSession: async () => null },
    resolveTenantSeat: async () => null,
  }, fakeDomainService()).request("/api/tenant/domains");
  assert.equal(unauthenticated.status, 401);
});

test("domain API always scopes operations to the resolved tenant, ignoring tenant IDs in request JSON", async () => {
  let createdFor = "";
  const domains = fakeDomainService({
    async create(tenantId, domainName) {
      createdFor = tenantId;
      assert.equal(domainName, "mail.example.com");
      return sampleDomain;
    },
  });
  const app = createApp(async () => true, activeSession, domains);
  const response = await app.request("/api/tenant/domains", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: "tenant-attacker", domainName: "mail.example.com" }),
  });

  assert.equal(response.status, 201);
  assert.equal(createdFor, "tenant-authorized");
  const result = await response.json() as { domain: TenantEmailDomain };
  assert.equal(result.domain.tenantId, "tenant-authorized");
});

test("domain list response contains only the active tenant's domains", async () => {
  let listedFor = "";
  const app = createApp(async () => true, activeSession, fakeDomainService({
    async list(tenantId) { listedFor = tenantId; return [sampleDomain]; },
  }));

  const response = await app.request("/api/tenant/domains");

  assert.equal(response.status, 200);
  assert.equal(listedFor, "tenant-authorized");
  assert.deepEqual(await response.json(), { domains: [sampleDomain] });
});

test("failed domain provisioning can be retried only through the authenticated tenant API", async () => {
  let retryTenant = "";
  const app = createApp(async () => true, activeSession, fakeDomainService({
    async retryCreate(tenantId) { retryTenant = tenantId; return sampleDomain; },
  }));
  const response = await app.request("/api/tenant/domains/domain-1/retry", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(retryTenant, "tenant-authorized");
});
