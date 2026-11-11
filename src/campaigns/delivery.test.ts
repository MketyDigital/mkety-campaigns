import assert from "node:assert/strict";
import test from "node:test";
import { createEmailCampaignWorker, type CampaignDeliveryJob, type CampaignDeliveryRepository } from "./delivery.js";
import type { EmailProvider } from "../email/providers.js";

const job: CampaignDeliveryJob = {
  id: "job-1", tenantId: "tenant-1", campaignId: "campaign-1", contactId: "contact-1",
  idempotencyKey: "campaign-1:contact-1", from: "info@mail.example.com", provider: "acs-email", to: "person@example.com",
  subject: "Hello", bodyText: "Thanks for subscribing.", unsubscribeUrl: `https://campaign.mkety.com/unsubscribe?token=${"a".repeat(43)}`,
};

test("campaign worker does nothing while the send gate is off", async () => {
  let claimed = false;
  const repository = fakeRepository({ async claimNext() { claimed = true; return job; } });
  const worker = createEmailCampaignWorker(repository, fakeProvider(), false);
  assert.equal(await worker.processOne(), false);
  assert.equal(claimed, false);
});

test("campaign worker sends a claimed job with stable idempotency and records acceptance", async () => {
  let sent: unknown;
  const repository = fakeRepository();
  const provider = fakeProvider({ async send(message) { sent = message; return { provider: "acs-email", providerMessageId: "provider-1", acceptedAt: "2026-11-03T12:00:00.000Z" }; } });
  const result = await createEmailCampaignWorker(repository, provider, true).processOne();
  assert.equal(result, true);
  assert.equal((sent as { idempotencyKey: string }).idempotencyKey, job.idempotencyKey);
  assert.equal((sent as { from: string }).from, job.from);
  assert.deepEqual((sent as { to: string[] }).to, [job.to]);
  assert.deepEqual((sent as { headers?: Record<string, string> }).headers, {
    "List-Unsubscribe": `<https://campaign.mkety.com/unsubscribe?token=${"a".repeat(43)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
  assert.equal(repository.accepted[0]?.providerMessageId, "provider-1");
});

test("campaign worker marks provider errors uncertain and never retries automatically", async () => {
  const repository = fakeRepository();
  let attempts = 0;
  const provider = fakeProvider({ async send() { attempts++; throw new Error("connection reset"); } });
  const worker = createEmailCampaignWorker(repository, provider, true);
  assert.equal(await worker.processOne(), true);
  assert.equal(await worker.processOne(), false);
  assert.equal(attempts, 1);
  assert.equal(repository.uncertain[0]?.id, job.id);
});

test("campaign worker routes a sender through its stored OCI adapter", async () => {
  let sent = false;
  const oci: EmailProvider = { name: "oci-email-delivery", async send() { sent = true; return { provider: "oci-email-delivery", acceptedAt: "2026-11-03T12:00:00.000Z" }; } };
  const repository = fakeRepository({ async claimNext() { return { ...job, provider: "oci-email-delivery" }; } });
  await createEmailCampaignWorker(repository, [fakeProvider(), oci], true).processOne();
  assert.equal(sent, true);
  assert.equal(repository.accepted[0]?.providerMessageId, undefined);
});

test("campaign worker marks an OCI sender uncertain when OCI credentials are absent", async () => {
  const repository = fakeRepository({ async claimNext() { return { ...job, provider: "oci-email-delivery" }; } });
  await createEmailCampaignWorker(repository, fakeProvider(), true).processOne();
  assert.match(repository.uncertain[0]?.error ?? "", /provider is not configured/i);
});

test("campaign worker does not claim jobs while the global emergency stop is active", async () => {
  let claimed = false;
  const repository = fakeRepository({
    async isEmergencyStopActive() { return true; },
    async claimNext() { claimed = true; return job; },
  });
  assert.equal(await createEmailCampaignWorker(repository, fakeProvider(), true).processOne(), false);
  assert.equal(claimed, false);
});

function fakeProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return { name: "acs-email", async send() { return { provider: "acs-email", acceptedAt: "2026-11-03T12:00:00.000Z" }; }, ...overrides };
}

function fakeRepository(overrides: Partial<CampaignDeliveryRepository> = {}) {
  const accepted: Array<{ id: string; providerMessageId?: string }> = [];
  const uncertain: Array<{ id: string; error: string }> = [];
  let claimed = false;
  const repository: CampaignDeliveryRepository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async markAccepted(id, result) { accepted.push({ id, providerMessageId: result.providerMessageId }); },
    async markUncertain(id, error) { uncertain.push({ id, error }); },
    ...overrides,
  };
  return Object.assign(repository, { accepted, uncertain });
}

test("worker never calls a provider without a usable unsubscribe URL", async () => {
  for (const unsubscribeUrl of [undefined, "", "not-a-url", "http://campaign.mkety.com/unsubscribe?token=abc", "https://campaign.mkety.com/unsubscribe", "https://campaign.mkety.com/other?token=abc"]) {
    let sendCalls = 0;
    const repository = fakeRepository({ async claimNext() { return { ...job, unsubscribeUrl }; } });
    const provider = fakeProvider({ async send() { sendCalls++; throw new Error("must not send"); } });
    assert.equal(await createEmailCampaignWorker(repository, provider, true).processOne(), true);
    assert.equal(sendCalls, 0, String(unsubscribeUrl));
    assert.equal(repository.accepted.length, 0);
    assert.equal(repository.uncertain.length, 1);
    assert.match(repository.uncertain[0].error, /unsubscribe link/i);
  }
});

test("worker accepts a localhost unsubscribe URL for development", async () => {
  let sendCalls = 0;
  const repository = fakeRepository({ async claimNext() { return { ...job, unsubscribeUrl: "http://localhost:3000/unsubscribe?token=test-token" }; } });
  const provider = fakeProvider({ async send() { sendCalls++; return { provider: "acs-email", acceptedAt: new Date().toISOString() }; } });
  await createEmailCampaignWorker(repository, provider, true).processOne();
  assert.equal(sendCalls, 1);
  assert.equal(repository.accepted.length, 1);
});
