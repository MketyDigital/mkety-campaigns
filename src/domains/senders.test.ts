import assert from "node:assert/strict";
import test from "node:test";
import { createTenantSenderService, type SenderIdentity, type SenderRepository } from "./senders.js";
import type { DomainRepository, TenantEmailDomain } from "./service.js";
import type { AzureCommunicationDomains } from "./azure-arm.js";

const verifiedDomain: TenantEmailDomain = {
  id: "domain-1", tenantId: "tenant-1", domainName: "mail.example.com", azureResourceId: "/domain/1",
  provisioningState: "Succeeded", linked: true,
  verificationRecords: { Domain: { type: "TXT", name: "@", value: "proof" }, SPF: { type: "TXT", name: "@", value: "spf" } },
  verificationStates: { Domain: { status: "Verified" }, SPF: { status: "Verified" } },
  updatedAt: "2026-11-03T00:00:00.000Z",
};

test("creates a sender identity only for a fully verified linked domain", async () => {
  const state = harness();
  const sender = await state.service.create("tenant-1", "domain-1", "Info", "MKETY Updates");
  assert.equal(sender.senderAddress, "info@mail.example.com");
  assert.equal(sender.provider, "acs-email");
  assert.equal(state.provisioned.length, 1);
  assert.equal(state.saved.length, 1);
});

test("does not provision senders for unverified, unlinked, or other-tenant domains", async () => {
  for (const domain of [
    { ...verifiedDomain, linked: false },
    { ...verifiedDomain, verificationStates: { Domain: { status: "NotStarted" }, SPF: { status: "Verified" } } },
    { ...verifiedDomain, tenantId: "tenant-other" },
  ]) {
    const state = harness(domain);
    await assert.rejects(state.service.create("tenant-1", "domain-1", "info", "Updates"), /domain.*ready/i);
    assert.equal(state.provisioned.length, 0);
  }
});

test("validates sender username and display name before calling Azure", async () => {
  const state = harness();
  await assert.rejects(state.service.create("tenant-1", "domain-1", "not an address", "Updates"), /username/i);
  await assert.rejects(state.service.create("tenant-1", "domain-1", "info", ""), /display name/i);
  assert.equal(state.provisioned.length, 0);
});

test("refreshes a pending sender from Azure and marks it ready after provisioning succeeds", async () => {
  const state = harness();
  const sender = await state.service.create("tenant-1", "domain-1", "info", "Updates");
  state.pending = true;
  const pending = await state.service.create("tenant-1", "domain-1", "news", "News");
  assert.equal(pending.status, "pending");
  state.remoteState = "Succeeded";

  const ready = await state.service.refresh("tenant-1", pending.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.id, pending.id);
  assert.equal(await state.service.refresh("tenant-other", pending.id), null);
  assert.equal(await state.service.refresh("tenant-1", sender.id), sender);
});

function harness(domain = verifiedDomain) {
  const provisioned: string[] = [];
  const saved: SenderIdentity[] = [];
  let pending = false;
  let remoteState = "Creating";
  const domains = { async get(tenantId: string, id: string) { return tenantId === domain.tenantId && id === domain.id ? domain : null; } } as unknown as DomainRepository;
  const repository: SenderRepository = {
    async list() { return saved; },
    async get(tenantId, id) { return saved.find((sender) => sender.tenantId === tenantId && sender.id === id) ?? null; },
    async insert(sender) { saved.push(sender); return sender; },
    async updateStatus(tenantId, id, status) {
      const sender = saved.find((item) => item.tenantId === tenantId && item.id === id);
      if (!sender) return null;
      sender.status = status;
      return sender;
    },
  };
  const provider = {
    async createSenderUsername(_domain: string, username: string) {
      provisioned.push(username);
      return { id: `sender-resource-${username}`, username, displayName: "Updates", provisioningState: pending ? "Creating" : "Succeeded" };
    },
    async getSenderUsername(_domain: string, username: string) {
      return { id: `sender-resource-${username}`, username, displayName: "Updates", provisioningState: remoteState };
    },
  } as unknown as AzureCommunicationDomains;
  return { service: createTenantSenderService(domains, repository, provider), provisioned, saved, set pending(value: boolean) { pending = value; }, set remoteState(value: string) { remoteState = value; } };
}
