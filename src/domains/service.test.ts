import assert from "node:assert/strict";
import test from "node:test";
import { createTenantDomainService, type DomainRepository, type NewTenantEmailDomain, type TenantDomainState, type TenantEmailDomain } from "./service.js";
import type { AzureCommunicationDomains, AzureDomainState, VerificationType } from "./azure-arm.js";

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

  await assert.rejects(service.create("tenant-1", "example.com"), /Azure could not provision/);
  const failed = store.rows[0]!;
  assert.equal(failed.provisioningState, "Failed");
  fail = false;

  const retried = await service.retryCreate("tenant-1", failed.id);
  assert.equal(retried?.provisioningState, "Running");
  assert.equal(retried?.domainName, "example.com");
  assert.deepEqual(arm.calls, ["create:example.com", "create:example.com"]);
});
