import assert from "node:assert/strict";
import test from "node:test";
import { createEmailTestSender } from "./test-send.js";
import type { SenderIdentity, SenderRepository } from "../domains/senders.js";
import type { EmailProvider } from "./providers.js";

const sender: SenderIdentity = {
  id: "sender-1", tenantId: "tenant-1", domainId: "domain-1", senderAddress: "info@mail.example.com",
  displayName: "MKETY Updates", provider: "acs-email", status: "ready", createdAt: "2026-11-03T00:00:00Z",
};

test("test send uses only the verified server-side sender and the signed-in user's address", async () => {
  let sent: unknown;
  const service = createEmailTestSender(senderRepository(sender), {
    name: "acs-email",
    async send(message) { sent = message; return { provider: "acs-email", acceptedAt: "2026-11-03T00:00:00Z" }; },
  } as EmailProvider);

  const result = await service.sendToAccountOwner("tenant-1", "sender-1", " Owner@Example.com ");

  assert.equal(result.provider, "acs-email");
  assert.deepEqual({ ...(sent as object), idempotencyKey: "omitted" }, {
    idempotencyKey: "omitted", from: sender.senderAddress, to: ["owner@example.com"],
    subject: "MKETY Campaigns sender test",
    text: `This is a test message sent from the verified campaign sender ${sender.senderAddress}. No campaign was sent.`,
  });
});

test("test send rejects pending senders, other tenants, and invalid account email", async () => {
  const provider = { name: "acs-email", async send() { throw new Error("must not send"); } } as unknown as EmailProvider;
  await assert.rejects(createEmailTestSender(senderRepository({ ...sender, status: "pending" }), provider).sendToAccountOwner("tenant-1", "sender-1", "owner@example.com"), /not ready/i);
  await assert.rejects(createEmailTestSender(senderRepository(null), provider).sendToAccountOwner("tenant-1", "sender-other", "owner@example.com"), /not ready/i);
  await assert.rejects(createEmailTestSender(senderRepository(sender), provider).sendToAccountOwner("tenant-1", "sender-1", "not-email"), /not ready/i);
});

function senderRepository(value: SenderIdentity | null): SenderRepository {
  return {
    async list() { return value ? [value] : []; },
    async get(tenantId, id) { return value?.tenantId === tenantId && value.id === id ? value : null; },
    async insert(item) { return item; },
    async updateStatus(tenantId, id, status) { return value?.tenantId === tenantId && value.id === id ? { ...value, status } : null; },
  };
}
