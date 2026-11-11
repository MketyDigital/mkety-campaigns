import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";
import type { TenantDomainService, TenantEmailDomain } from "./domains/service.js";
import type { CampaignWorkspace } from "./campaigns/workspace.js";
import type { CampaignDispatchRepository } from "./campaigns/delivery-repository.js";
import type { OperationsService } from "./ops/service.js";
import type { TenantSenderService, SenderIdentity } from "./domains/senders.js";
import type { EmailTestSender } from "./email/test-send.js";

const activeSession = {
  auth: {
    handler: async () => new Response(null, { status: 404 }),
    getSession: async () => ({ user: { id: "user-1", email: "owner@example.com", role: "tenant", twoFactorEnabled: true }, session: { createdAt: new Date() } }),
  },
  resolveTenantSeat: async (userId: string) => userId === "user-1" ? "tenant-authorized" : null,
};

const sampleDomain: TenantEmailDomain = {
  id: "domain-1",
  tenantId: "tenant-authorized",
  domainName: "mail.example.com",
  provider: "acs-email",
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

test("Ops dashboard redirects to MKETY Auth when no operator session exists", async () => {
  const response = await createApp().request("/app/ops");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/ops-login?error=not_configured");
});

test("Ops login offers the MKETY identity provider", async () => {
  const response = await createApp().request("/ops-login");
  const html = await response.text();
  assert.match(html, /Continue with MKETY Auth/);
  assert.match(html, /\/api\/ops\/auth\/login/);
});

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

test("state-changing workspace requests reject an untrusted browser origin", async () => {
  let created = false;
  const security = { ...activeSession, trustedOrigins: ["https://campaign.mkety.com"] };
  const app = createApp(async () => true, security, fakeDomainService({ async create() { created = true; return sampleDomain; } }));
  const response = await app.request("/api/tenant/domains", {
    method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({ domainName: "mail.example.com" }),
  });
  assert.equal(response.status, 403);
  assert.equal(created, false);
});

test("same-origin GETs remain usable when trusted-origin checks are enabled", async () => {
  const app = createApp(async () => true, { ...activeSession, trustedOrigins: ["https://campaign.mkety.com"] });
  const response = await app.request("/api/tenant/me");
  assert.equal(response.status, 200);
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

test("contacts and campaign pages are linked from the workspace", async () => {
  const html = await (await createApp().request("/")).text();
  assert.match(html, /href="\/app\/contacts"/);
  assert.match(html, /href="\/app\/campaigns"/);
  assert.match(await (await createApp().request("/app/contacts")).text(), /Import permission-based contacts/);
  assert.match(await (await createApp().request("/app/contacts")).text(), /Withdraw email consent/);
  assert.match(await (await createApp().request("/app/campaigns")).text(), /Create a campaign draft/);
  assert.match(await (await createApp().request("/app/campaigns")).text(), /Submit for review/);
  const operatorSecurity = {
    ...activeSession,
    operatorAuth: {
      start: async () => new Response(null, { status: 302 }),
      callback: async () => new Response(null, { status: 302 }),
      session: async () => ({ id: "ops-1", email: "ops@example.com" }),
      logout: async () => new Response(null, { status: 302 }),
    },
  };
  const opsHtml = await (await createApp(async () => true, operatorSecurity).request("/app/ops")).text();
  assert.match(opsHtml, /Campaigns awaiting review/);
  assert.match(opsHtml, /Approved email campaigns/);
});

test("sign-in and required authenticator setup pages are available", async () => {
  assert.match(await (await createApp().request("/")).text(), /href="\/login"/);
  assert.match(await (await createApp().request("/login")).text(), /Sign in to MKETY Campaigns/);
  const mfa = await (await createApp().request("/app/setup-mfa")).text();
  assert.match(mfa, /authenticator app/i);
  assert.match(mfa, /backup codes/i);
});

test("workspace dashboard authorizes the active tenant seat and links core tools", async () => {
  const response = await createApp(async () => true, activeSession).request("/app");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Campaign workspace/);
  const anonymous = await createApp().request("/app", { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/login");
});

test("sender identity page explains readiness and owner-only test sending", async () => {
  const html = await (await createApp().request("/app/senders")).text();
  assert.match(html, /Create sender identity/);
  assert.match(html, /test email to your signed-in account/i);
});

test("contact imports validate consent and use the authenticated tenant", async () => {
  let received: { tenantId: string; channel: string } | undefined;
  const workspace = fakeCampaignWorkspace({
    async importContacts(tenantId, channel) { received = { tenantId, channel }; return { imported: 1 }; },
  });
  const app = createApp(async () => true, activeSession, fakeDomainService(), workspace);
  const response = await app.request("/api/tenant/contacts/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: "attacker-tenant", channel: "email", rows: [{ email: "person@example.com", emailConsent: true, consentSource: "signup", consentEvidenceRef: "form-1", consentOccurredAt: "2026-11-02T12:00:00Z" }] }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(received, { tenantId: "tenant-authorized", channel: "email" });

  const invalid = await app.request("/api/tenant/contacts/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "email", rows: [{ email: "person2@example.com" }] }),
  });
  assert.equal(invalid.status, 400);
});

test("campaign drafts resolve an owner sender identity and tenant server-side", async () => {
  let received: { tenantId: string; draft: { channel: string; senderIdentityId?: string; subject?: string; bodyText: string } } | undefined;
  const workspace = fakeCampaignWorkspace({
    async createCampaign(tenantId, draft) { received = { tenantId, draft }; return { id: "campaign-1", tenantId, ...draft, status: "draft", createdAt: "2026-11-02T12:00:00.000Z" }; },
  });
  const app = createApp(async () => true, activeSession, fakeDomainService(), workspace, undefined, fakeSenderService());
  const response = await app.request("/api/tenant/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: "attacker-tenant", channel: "email", senderIdentityId: "sender-1", subject: "Hello", bodyText: "Hi", from: "attacker@example.com" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(received, { tenantId: "tenant-authorized", draft: { channel: "email", senderIdentityId: "sender-1", subject: "Hello", bodyText: "Hi" } });
});

test("campaign review submission is tenant-scoped and never sends", async () => {
  let submitted: { tenantId: string; campaignId: string } | undefined;
  const workspace = fakeCampaignWorkspace({
    async submitForReview(tenantId, campaignId) {
      submitted = { tenantId, campaignId };
      return { id: campaignId, tenantId, channel: "email", subject: "Hello", bodyText: "Hi", status: "in_review", createdAt: "2026-11-02T12:00:00.000Z" };
    },
  });
  const app = createApp(async () => true, activeSession, fakeDomainService(), workspace);
  const response = await app.request("/api/tenant/campaigns/campaign-1/submit", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(submitted, { tenantId: "tenant-authorized", campaignId: "campaign-1" });
  assert.equal((await response.json() as { campaign: { status: string } }).campaign.status, "in_review");
});

test("only MFA-enabled Ops can approve a submitted campaign, without dispatching it", async () => {
  let reviewed: { campaignId: string; userId: string; decision: string } | undefined;
  const workspace = fakeCampaignWorkspace({
    async reviewCampaign(campaignId, userId, decision) {
      reviewed = { campaignId, userId, decision };
      return { id: campaignId, tenantId: "tenant-authorized", channel: "email", subject: "Hello", bodyText: "Hi", status: "approved", createdAt: "2026-11-02T12:00:00.000Z" };
    },
  });
  const opsSession = {
    auth: { handler: async () => new Response(), getSession: async () => ({ user: { id: "ops-1", role: "ops", twoFactorEnabled: true }, session: { createdAt: new Date() } }) },
    resolveTenantSeat: async () => null,
    resolveOpsAdmin: async () => true,
  };
  const app = createApp(async () => true, opsSession, fakeDomainService(), workspace);
  const response = await app.request("/api/ops/campaigns/campaign-1/review", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(reviewed, { campaignId: "campaign-1", userId: "ops-1", decision: "approve" });
  assert.equal((await response.json() as { campaign: { status: string } }).campaign.status, "approved");
});

test("approved email delivery queueing requires its explicit runtime gate and MFA Ops", async () => {
  let queued: { id: string; actor: string; limit: number } | undefined;
  const dispatch: CampaignDispatchRepository = {
    async queueApproved(id, actor, limit) { queued = { id, actor, limit }; return 2; },
    async claimNext() { return null; },
    async markAccepted() {},
    async markUncertain() {},
  };
  const opsSecurity = {
    ...{
      auth: { handler: async () => new Response(), getSession: async () => ({ user: { id: "ops-1", role: "ops", twoFactorEnabled: true }, session: { createdAt: new Date() } }) },
      resolveTenantSeat: async () => null,
      resolveOpsAdmin: async () => true,
      trustedOrigins: ["https://campaign.mkety.com"],
    },
  };
  const body = { method: "POST", headers: { origin: "https://campaign.mkety.com" } };
  const disabled = createApp(async () => true, opsSecurity, fakeDomainService(), fakeCampaignWorkspace(), undefined, undefined, undefined, dispatch, false);
  const disabledResponse = await disabled.request("/api/ops/campaigns/campaign-1/dispatch", body);
  assert.equal(disabledResponse.status, 503);
  assert.equal(queued, undefined);

  const enabled = createApp(async () => true, opsSecurity, fakeDomainService(), fakeCampaignWorkspace(), undefined, undefined, undefined, dispatch, true, 50);
  const response = await enabled.request("/api/ops/campaigns/campaign-1/dispatch", body);
  assert.equal(response.status, 202);
  assert.deepEqual(queued, { id: "campaign-1", actor: "ops-1", limit: 50 });
  assert.deepEqual(await response.json(), { queued: 2, status: "queued" });
});

test("contact consent withdrawal is tenant-scoped and suppresses the selected channel", async () => {
  let withdrawn: { tenantId: string; contactId: string; channel: string } | undefined;
  const workspace = fakeCampaignWorkspace({
    async withdrawConsent(tenantId, contactId, channel) {
      withdrawn = { tenantId, contactId, channel };
      return true;
    },
  });
  const app = createApp(async () => true, activeSession, fakeDomainService(), workspace);
  const response = await app.request("/api/tenant/contacts/contact-1/withdraw", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "email", tenantId: "attacker" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(withdrawn, { tenantId: "tenant-authorized", contactId: "contact-1", channel: "email" });
  const invalid = await app.request("/api/tenant/contacts/contact-1/withdraw", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "voice" }),
  });
  assert.equal(invalid.status, 400);
});

test("public unsubscribe route accepts only opaque tokens and records opt-out without login", async () => {
  let tokenUsed: string | undefined;
  const workspace = fakeCampaignWorkspace({ async unsubscribe(token) { tokenUsed = token; return token === "A".repeat(43); } });
  const app = createApp(async () => true, undefined, undefined, workspace);
  const invalid = await app.request("/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "bad" }) });
  assert.equal(invalid.status, 400);
  const response = await app.request("/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "A".repeat(43) }) });
  assert.equal(response.status, 200);
  assert.equal(tokenUsed, "A".repeat(43));
  const oneClick = await app.request("/unsubscribe?token=" + "A".repeat(43), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(oneClick.status, 200);
  assert.equal(tokenUsed, "A".repeat(43));
  assert.match(await (await app.request("/unsubscribe?token=" + "A".repeat(43))).text(), /Unsubscribe/);
});

test("tenant sender API provisions only through the active tenant's verified-domain service", async () => {
  let created: { tenantId: string; domainId: string; username: string; displayName: string } | undefined;
  const app = createApp(async () => true, activeSession, fakeDomainService(), fakeCampaignWorkspace(), fakeOperationsService(), fakeSenderService({
    async create(tenantId, domainId, username, displayName) {
      created = { tenantId, domainId, username, displayName };
      return sampleSender;
    },
  }));
  const response = await app.request("/api/tenant/senders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: "attacker", domainId: "domain-1", username: "info", displayName: "Updates", senderAddress: "bad@example.net", provider: "oci" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(created, { tenantId: "tenant-authorized", domainId: "domain-1", username: "info", displayName: "Updates" });
});

test("sender provisioning refresh is scoped to the active tenant", async () => {
  let refreshed: { tenantId: string; senderId: string } | undefined;
  const app = createApp(async () => true, activeSession, fakeDomainService(), fakeCampaignWorkspace(), fakeOperationsService(), fakeSenderService({
    async refresh(tenantId, senderId) { refreshed = { tenantId, senderId }; return sampleSender; },
  }));
  const response = await app.request("/api/tenant/senders/sender-1/refresh", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(refreshed, { tenantId: "tenant-authorized", senderId: "sender-1" });
});

test("email test-send is gated and sends only to the authenticated account address", async () => {
  let sentTo: string | undefined;
  const testSender: EmailTestSender = { async sendToAccountOwner(_tenantId, _senderId, email) { sentTo = email; return { provider: "acs-email", acceptedAt: "2026-11-03T00:00:00.000Z" }; } };
  const app = createApp(async () => true, activeSession, fakeDomainService(), fakeCampaignWorkspace(), fakeOperationsService(), fakeSenderService(), testSender);
  const response = await app.request("/api/tenant/senders/sender-1/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "attacker@example.net", from: "attacker@example.net" }),
  });
  assert.equal(response.status, 200);
  assert.equal(sentTo, "owner@example.com");

  const disabled = await createApp(async () => true, activeSession, fakeDomainService(), fakeCampaignWorkspace(), fakeOperationsService(), fakeSenderService()).request("/api/tenant/senders/sender-1/test", { method: "POST" });
  assert.equal(disabled.status, 503);
});

test("CSV import validates all rows before saving contacts", async () => {
  let importedCount = 0;
  const workspace = fakeCampaignWorkspace({
    async importContacts(_tenantId, _channel, rows) { importedCount = rows.length; return { imported: rows.length }; },
  });
  const app = createApp(async () => true, activeSession, fakeDomainService(), workspace);
  const csv = "email,email_consent,consent_source,consent_evidence_ref,consent_occurred_at\nperson@example.com,true,checkout,order-1,2026-11-02T12:00:00Z";
  const response = await app.request("/api/tenant/contacts/import-csv?channel=email", {
    method: "POST", headers: { "content-type": "text/csv" }, body: csv,
  });
  assert.equal(response.status, 201);
  assert.equal(importedCount, 1);
  const rejected = await app.request("/api/tenant/contacts/import-csv?channel=email", {
    method: "POST", headers: { "content-type": "text/csv" }, body: csv.replace("true,checkout", "false,checkout"),
  });
  assert.equal(rejected.status, 400);
  assert.equal(importedCount, 1);
});

test("tenant seat cannot create operator invitations", async () => {
  const app = createApp(async () => true, activeSession, fakeDomainService(), fakeCampaignWorkspace(), fakeOperationsService());
  const response = await app.request("/api/ops/tenant-invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantName: "Customer", email: "owner@example.com" }) });
  assert.equal(response.status, 403);
});

test("MFA-enabled Ops can create a one-time customer invite", async () => {
  let created: { tenantName: string; email: string } | undefined;
  const opsSession = {
    auth: { handler: async () => new Response(), getSession: async () => ({ user: { id: "ops-1", role: "ops", twoFactorEnabled: true }, session: { createdAt: new Date() } }) },
    resolveTenantSeat: async () => null,
    resolveOpsAdmin: async () => true,
  };
  const operations = fakeOperationsService({
    async createTenantInvite(tenantName, email) { created = { tenantName, email }; return { inviteUrl: "https://campaign.mkety.com/invite/accept?token=one-time" }; },
  });
  const app = createApp(async () => true, opsSession, fakeDomainService(), fakeCampaignWorkspace(), operations);
  const response = await app.request("/api/ops/tenant-invitations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantName: "Customer Inc", email: "OWNER@example.com" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(created, { tenantName: "Customer Inc", email: "OWNER@example.com" });
  assert.deepEqual(await response.json(), { inviteUrl: "https://campaign.mkety.com/invite/accept?token=one-time" });
});

function fakeOperationsService(overrides: Partial<OperationsService> = {}): OperationsService {
  return {
    async createTenantInvite() { return { inviteUrl: "https://campaign.mkety.com/invite/accept?token=test" }; },
    async acceptInvite() { return true; },
    ...overrides,
  };
}

function fakeCampaignWorkspace(overrides: Partial<CampaignWorkspace> = {}): CampaignWorkspace {
  return {
    async listContacts() { return []; },
    async importContacts() { return { imported: 0 }; },
    async listCampaigns() { return []; },
    async createCampaign(tenantId, draft) { return { id: "campaign-1", tenantId, ...draft, status: "draft", createdAt: "2026-11-02T12:00:00.000Z" }; },
    async submitForReview(tenantId, campaignId) { return { id: campaignId, tenantId, channel: "email", subject: "Hello", bodyText: "Hi", status: "in_review", createdAt: "2026-11-02T12:00:00.000Z" }; },
    async listCampaignsInReview() { return []; },
    async reviewCampaign(campaignId, _userId, decision) { return { id: campaignId, tenantId: "tenant-authorized", channel: "email", subject: "Hello", bodyText: "Hi", status: decision === "approve" ? "approved" : "rejected", createdAt: "2026-11-02T12:00:00.000Z" }; },
    async withdrawConsent() { return true; },
    async listApprovedCampaigns() { return []; },
    async unsubscribe() { return true; },
    ...overrides,
  };
}

const sampleSender: SenderIdentity = { id: "sender-1", tenantId: "tenant-authorized", domainId: "domain-1", senderAddress: "info@mail.example.com", displayName: "Updates", provider: "acs-email", status: "ready", createdAt: "2026-11-03T00:00:00.000Z" };

function fakeSenderService(overrides: Partial<TenantSenderService> = {}): TenantSenderService {
  return {
    async list() { return [sampleSender]; },
    async get(tenantId, id) { return tenantId === sampleSender.tenantId && id === sampleSender.id ? sampleSender : null; },
    async create() { return sampleSender; },
    async refresh() { return sampleSender; },
    ...overrides,
  };
}

test("security headers prevent browser caching of authenticated and authentication pages", async () => {
  const app = createApp();
  for (const path of ["/login", "/app", "/api/tenant/me", "/api/auth/sign-in/email"]) {
    const response = await app.request(path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
  }
  const publicResponse = await app.request("/healthz");
  assert.equal(publicResponse.headers.get("cache-control"), null);
  assert.equal(publicResponse.headers.get("x-content-type-options"), "nosniff");
});
