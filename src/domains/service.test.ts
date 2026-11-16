import assert from "node:assert/strict";
import test from "node:test";
import { createTenantDomainService, DomainFallbackNotSafeError, DomainProvisioningError, type DomainRepository, type NewTenantEmailDomain, type TenantDomainState, type TenantEmailDomain } from "./service.js";
import { EmailDomainProviderError, type AzureCommunicationDomains, type AzureDomainState, type VerificationType } from "./azure-arm.js";

function domainState(overrides: Partial<AzureDomainState> = {}): AzureDomainState {
  return {
    id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Communication/emailServices/email/domains/example.com",
    name: "example.com",
    provisioningState: "Running",
    verificationRecords: { Domain: { type: "TXT", name: "@", value: "verify", ttl: 3600 } },
    verificationStates: { Domain: { status: "NotStarted" } },
    linked: false,
    ...overrides,
  };
}

function repository(): DomainRepository & { rows: TenantEmailDomain[] } {
  const rows: TenantEmailDomain[] = [];
  return {
    rows,
    async list(tenantId) { return rows.filter((row) => row.tenantId === tenantId); },
    async get(tenantId, id) { return rows.find((row) => row.tenantId === tenantId && row.id === id) ?? null; },
    async getById(id) { return rows.find((row) => row.id === id) ?? null; },
    async switchProviderIfFailed(id, from, to) {
      const row = rows.find((item) => item.id === id && item.provider === from && item.provisioningState === "Failed");
      if (!row) return null;
      Object.assign(row, { provider: to, provisioningState: "Pending", azureResourceId: null, verificationRecords: {}, verificationStates: {}, linked: false });
      return row;
    },
    async insertPending(row: NewTenantEmailDomain) {
      if (rows.some((item) => item.domainName === row.domainName)) throw new Error("duplicate domain");
      const saved: TenantEmailDomain = {
        ...row,
        azureResourceId: null,
        provisioningState: "Pending",
        verificationRecords: {},
        verificationStates: {},
        linked: false,
        updatedAt: new Date().toISOString(),
        providerErrorStatus: null,
        providerErrorCode: null,
        providerRequestId: null,
        providerErrorAt: null,
      };
      rows.push(saved);
      return saved;
    },
    async saveState(tenantId: string, id: string, state: TenantDomainState) {
      const row = rows.find((item) => item.tenantId === tenantId && item.id === id);
      if (!row) return null;
      Object.assign(row, state, { updatedAt: new Date().toISOString() });
      return row;
    },
  };
}

function provider(overrides: Partial<AzureCommunicationDomains> = {}): AzureCommunicationDomains & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createDomain(name) { calls.push(`create:${name}`); return domainState({ name }); },
    async getDomain(name) { calls.push(`get:${name}`); return domainState({ name }); },
    async initiateVerification(name, type: VerificationType) { calls.push(`verify:${name}:${type}`); },
    async linkVerifiedDomain(name) { calls.push(`link:${name}`); },
    async createSenderUsername(domainName, username, displayName) { return { id: `/${domainName}/${username}`, username, displayName, provisioningState: "Succeeded" }; },
    async getSenderUsername(domainName, username) { return { id: `/${domainName}/${username}`, username, displayName: username, provisioningState: "Succeeded" }; },
    ...overrides,
  };
}

test("creates and persists a normalized domain under the authenticated tenant", async () => {
  const store = repository();
  const arm = provider();
  const service = createTenantDomainService(store, arm);

  const saved = await service.create("tenant-1", " Mail.Example.com. ");

  assert.equal(saved.tenantId, "tenant-1");
  assert.equal(saved.domainName, "mail.example.com");
  assert.equal(saved.azureResourceId, domainState().id);
  assert.equal(saved.provisioningState, "Running");
  assert.equal(arm.calls[0], "create:mail.example.com");
  assert.equal(store.rows.length, 1);
});

test("new domains use the Ops-selected provider adapter while retaining their provider identity", async () => {
  const store = repository();
  const azure = provider();
  const oci = provider();
  const originalCreate = oci.createDomain;
  oci.createDomain = async (name) => ({ ...(await originalCreate(name)), id: `oci:${name}` });
  const service = createTenantDomainService(store, { "acs-email": azure, "oci-email-delivery": oci }, async () => "oci-email-delivery");

  const saved = await service.create("tenant-1", "mail.example.com");

  assert.equal(saved.provider, "oci-email-delivery");
  assert.equal(saved.azureResourceId, "oci:mail.example.com");
  assert.deepEqual(azure.calls, []);
  assert.deepEqual(oci.calls, ["create:mail.example.com"]);
});

test("provider rejection diagnostics persist only safe status, code, and request ID", async () => {
  const store = repository();
  const arm = provider({ async createDomain() { throw new EmailDomainProviderError("acs-email", 403, "AuthorizationFailed", "req-123"); } });
  const service = createTenantDomainService(store, arm);
  await assert.rejects(service.create("tenant-1", "mail.example.com"), DomainProvisioningError);
  assert.equal(store.rows[0]?.provisioningState, "Failed");
  assert.equal(store.rows[0]?.providerErrorStatus, 403);
  assert.equal(store.rows[0]?.providerErrorCode, "AuthorizationFailed");
  assert.equal(store.rows[0]?.providerRequestId, "req-123");
  assert.doesNotMatch(JSON.stringify(store.rows[0]), /token|secret|response body/i);
});

test("Ops cannot switch a failed domain when its original provider cannot confirm absence", async () => {
  const store = repository();
  const source = provider({ async createDomain() { throw new EmailDomainProviderError("acs-email", 403, "AuthorizationFailed"); }, async getDomain() { throw new EmailDomainProviderError("acs-email", 503, "ServiceUnavailable"); } });
  const target = provider();
  const service = createTenantDomainService(store, { "acs-email": source, "oci-email-delivery": target });
  await assert.rejects(service.create("tenant-1", "mail.example.com"), DomainProvisioningError);
  await assert.rejects(service.retryFailedOnProvider!(store.rows[0]!.id, "oci-email-delivery"), DomainFallbackNotSafeError);
  assert.equal(store.rows[0]?.provider, "acs-email");
  assert.deepEqual(target.calls, []);
});

test("Ops switches a failed domain only after the original provider confirms 404", async () => {
  const store = repository();
  const source = provider({ async createDomain() { throw new EmailDomainProviderError("acs-email", 403, "AuthorizationFailed"); }, async getDomain() { throw new EmailDomainProviderError("acs-email", 404, "ResourceNotFound"); } });
  const target = provider();
  const service = createTenantDomainService(store, { "acs-email": source, "oci-email-delivery": target });
  await assert.rejects(service.create("tenant-1", "mail.example.com"), DomainProvisioningError);
  const result = await service.retryFailedOnProvider!(store.rows[0]!.id, "oci-email-delivery");
  assert.equal(result?.provider, "oci-email-delivery");
  assert.equal(result?.provisioningState, "Running");
  assert.equal(store.rows[0]?.provider, "oci-email-delivery");
  assert.deepEqual(target.calls, ["create:mail.example.com"]);
});

test("does not expose or return a domain belonging to another tenant", async () => {
  const store = repository();
  const service = createTenantDomainService(store, provider());
  const created = await service.create("tenant-1", "example.com");

  assert.equal(await service.get("tenant-2", created.id), null);
  assert.deepEqual(await service.list("tenant-2"), []);
});

test("refreshes provider verification and links only after every published DNS record is verified", async () => {
  const store = repository();
  const arm = provider({
    async getDomain(name) {
      arm.calls.push(`get:${name}`);
      return domainState({
        name,
        provisioningState: "Succeeded",
        verificationRecords: { Domain: { type: "TXT", name: "@", value: "verify", ttl: 3600 }, SPF: { type: "TXT", name: "@", value: "spf", ttl: 3600 } },
        verificationStates: { Domain: { status: "Verified" }, SPF: { status: "NotStarted" } },
      });
    },
  });
  const service = createTenantDomainService(store, arm);
  const created = await service.create("tenant-1", "example.com");

  const pending = await service.refresh("tenant-1", created.id);
  assert.equal(pending?.linked, false);
  assert.equal(arm.calls.includes("link:example.com"), false);

  arm.getDomain = async (name) => {
    arm.calls.push(`get:${name}`);
    return domainState({
      name,
      provisioningState: "Succeeded",
      verificationRecords: { Domain: { type: "TXT", name: "@", value: "verify", ttl: 3600 }, SPF: { type: "TXT", name: "@", value: "spf", ttl: 3600 } },
      verificationStates: { Domain: { status: "Verified" }, SPF: { status: "Verified" } },
    });
  };
  const ready = await service.refresh("tenant-1", created.id);
  assert.equal(ready?.linked, true);
  assert.equal(arm.calls.includes("link:example.com"), true);
});

test("allows a tenant to retry a domain after transient Azure creation failure", async () => {
  const store = repository();
  let fail = true;
  const arm = provider({
    async createDomain(name) {
      arm.calls.push(`create:${name}`);
      if (fail) throw new Error("temporary Azure error");
      return domainState({ name, provisioningState: "Running" });
    },
  });
  const service = createTenantDomainService(store, arm);

  await assert.rejects(service.create("tenant-1", "example.com"), /selected email provider could not provision/);
  const failed = store.rows[0]!;
  assert.equal(failed.provisioningState, "Unknown");
  fail = false;

  await assert.rejects(service.retryCreate("tenant-1", failed.id), /Only a failed domain provisioning operation/i);
  assert.deepEqual(arm.calls, ["create:example.com"]);
});

test("refresh preserves an uncertain OCI outcome when a follow-up list read temporarily returns 404", async () => {
  const store = repository();
  let createCalls = 0;
  const oci = provider({
    async createDomain() { createCalls++; throw new EmailDomainProviderError("oci-email-delivery", 503, "ServiceUnavailable", "request-1"); },
    async getDomain() { throw new EmailDomainProviderError("oci-email-delivery", 404, "NotFound"); },
  });
  const service = createTenantDomainService(store, { "oci-email-delivery": oci }, "oci-email-delivery");
  await assert.rejects(service.create("tenant-1", "mail.example.com"), DomainProvisioningError);
  const before = store.rows[0]!;
  assert.equal(before.provisioningState, "Unknown");
  const refreshed = await service.refresh("tenant-1", before.id);
  assert.equal(refreshed?.provisioningState, "Unknown");
  assert.equal(refreshed?.providerRequestId, "request-1");
  assert.equal(createCalls, 1);
});
