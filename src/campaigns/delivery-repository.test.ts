import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { D1CampaignDispatchRepository } from "./delivery-repository.js";
import { D1EmailEventReconciler } from "../email/delivery-reconciliation.js";
import { D1CampaignWorkspace } from "./repository.js";

class SqliteD1 {
  private readonly db = new DatabaseSync(":memory:");
  constructor() {
    for (const file of readdirSync("migrations/d1").filter((path) => path.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(`migrations/d1/${file}`, "utf8"));
    }
  }
  prepare(query: string) {
    const db = this.db;
    let values: SQLInputValue[] = [];
    return {
      bind(...input: SQLInputValue[]) { values = input; return this; },
      async first<T>(column?: string): Promise<T | null> {
        const row = db.prepare(query).get(...values) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        const results = db.prepare(query).all(...values) as T[];
        return { results, success: true, meta: { changes: 0 } };
      },
      async run() {
        const result = db.prepare(query).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.db.close(); }
}

async function seedCampaign(db: SqliteD1, recipientCount = 1, provider: "acs-email" | "oci-email-delivery" = "acs-email") {
  const exec = async (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).bind(...args).run();
  await exec("INSERT INTO tenants (id, name, status) VALUES ('tenant-1', 'Example', 'approved')");
  await exec("INSERT INTO users (id, email, display_name, role, two_factor_enabled, mfa_enrolled_at) VALUES ('ops-1', 'ops@example.com', 'Ops', 'ops', 1, CURRENT_TIMESTAMP)");
  await exec("INSERT INTO tenant_email_domains (id, tenant_id, domain_name, provisioning_state, linked) VALUES ('domain-1', 'tenant-1', 'mail.example.com', 'Succeeded', 1)");
  await exec("INSERT INTO tenant_sender_identities (id, tenant_id, domain_id, sender_address, display_name, provider, status) VALUES ('sender-1', 'tenant-1', 'domain-1', 'info@mail.example.com', 'Updates', ?1, 'ready')", provider);
  await exec("INSERT INTO campaigns (id, tenant_id, channel, status, sender_identity_id, subject, body_text) VALUES ('campaign-1', 'tenant-1', 'email', 'approved', 'sender-1', 'Welcome', 'Hello there')");
  for (let index = 1; index <= recipientCount; index++) {
    const contact = `contact-${index}`;
    const email = `person${index}@example.com`;
    await exec("INSERT INTO contacts (id, tenant_id, email) VALUES (?1, 'tenant-1', ?2)", contact, email);
    await exec("INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at) VALUES (?1, 'tenant-1', ?2, 'email', 'granted', 'signup', ?3, CURRENT_TIMESTAMP)", `consent-${index}`, contact, `form-${index}`);
  }
}

test("D1 dispatch queues consented recipients with opaque unsubscribe links and suppresses after opt-out", async () => {
  const db = new SqliteD1();
  try {
    await seedCampaign(db);
    const repository = new D1CampaignDispatchRepository(db as unknown as D1Database, "https://campaign.mkety.com");
    assert.equal(await repository.queueApproved("campaign-1", "ops-1", 10), 1);
    const job = await repository.claimNext();
    assert.equal(job?.to, "person1@example.com");
    assert.match(job?.unsubscribeUrl ?? "", /^https:\/\/campaign\.mkety\.com\/unsubscribe\?token=[A-Za-z0-9_-]{40,64}$/);
    assert.doesNotMatch(job?.unsubscribeUrl ?? "", /person1@example\.com|contact-1|tenant-1/);
    const token = new URL(job!.unsubscribeUrl!).searchParams.get("token")!;
    assert.equal(await new D1CampaignWorkspace(db as unknown as D1Database).unsubscribe(token), true);
    await repository.markAccepted(job!.id, { provider: "acs-email", acceptedAt: new Date().toISOString() });
    const state = await db.prepare("SELECT status FROM campaigns WHERE id = 'campaign-1'").first<{ status: string }>();
    assert.equal(state?.status, "sent");
  } finally { db.close(); }
});

test("D1 dispatch rejects the whole queue when eligible recipients exceed the cap", async () => {
  const db = new SqliteD1();
  try {
    await seedCampaign(db, 2);
    const repository = new D1CampaignDispatchRepository(db as unknown as D1Database, "https://campaign.mkety.com");
    await assert.rejects(repository.queueApproved("campaign-1", "ops-1", 1), /configured recipient limit/i);
    const jobs = await db.prepare("SELECT COUNT(*) AS count FROM campaign_jobs").first<{ count: number }>();
    const status = await db.prepare("SELECT status FROM campaigns WHERE id = 'campaign-1'").first<{ status: string }>();
    assert.equal(jobs?.count, 0);
    assert.equal(status?.status, "approved");
  } finally { db.close(); }
});

test("D1 campaign jobs retain and route the provider attached to the sender", async () => {
  const db = new SqliteD1();
  try {
    await seedCampaign(db, 1, "oci-email-delivery");
    const repository = new D1CampaignDispatchRepository(db as unknown as D1Database, "https://campaign.mkety.com");
    assert.equal(await repository.queueApproved("campaign-1", "ops-1", 1), 1);
    const job = await repository.claimNext();
    assert.equal(job?.provider, "oci-email-delivery");
  } finally { db.close(); }
});

test("authenticated delivery reconciliation suppresses bounced contacts idempotently", async () => {
  const db = new SqliteD1();
  try {
    await seedCampaign(db);
    const queue = new D1CampaignDispatchRepository(db as unknown as D1Database, "https://campaign.mkety.com");
    await queue.queueApproved("campaign-1", "ops-1", 10);
    const job = await queue.claimNext();
    assert.ok(job);
    await queue.markAccepted(job.id, { provider: "acs-email", providerMessageId: "provider-message-1", acceptedAt: "2026-11-10T10:00:00Z" });
    const reconciler = new D1EmailEventReconciler(db as unknown as D1Database);
    const event = { provider: "acs-email", providerMessageId: "provider-message-1", eventId: "evt-1", outcome: "bounced", occurredAt: "2026-11-10T11:00:00Z" };
    assert.equal(await reconciler.reconcile(event), "recorded");
    assert.equal(await reconciler.reconcile(event), "duplicate");
    const attempt = await db.prepare("SELECT status FROM delivery_attempts WHERE provider_message_id = 'provider-message-1'").first<{ status: string }>();
    assert.equal(attempt?.status, "bounced");
    const block = await db.prepare("SELECT reason, address_normalized FROM suppressions WHERE tenant_id = 'tenant-1' AND channel = 'email'").first<{ reason: string; address_normalized: string }>();
    assert.equal(block?.reason, "bounced");
    assert.equal(block?.address_normalized, "person1@example.com");
    const count = await db.prepare("SELECT COUNT(*) AS count FROM email_delivery_events").first<{ count: number }>();
    assert.equal(count?.count, 1);
    assert.equal(await reconciler.reconcile({ ...event, eventId: "evt-late", outcome: "delivered", occurredAt: "2026-11-10T12:00:00Z" }), "recorded");
    const after = await db.prepare("SELECT status FROM delivery_attempts WHERE provider_message_id = 'provider-message-1'").first<{ status: string }>();
    assert.equal(after?.status, "bounced", "late delivery confirmation must not unsuppress a bounce");
  } finally { db.close(); }
});

test("reconciliation cannot select arbitrary tenants and ignores unknown provider messages", async () => {
  const db = new SqliteD1();
  try {
    await seedCampaign(db);
    const reconciler = new D1EmailEventReconciler(db as unknown as D1Database);
    assert.equal(await reconciler.reconcile({
      provider: "acs-email", eventId: "unknown", providerMessageId: "unmatched",
      outcome: "complained", occurredAt: "2026-11-10T11:00:00Z",
      tenantId: "tenant-1", recipient: "person1@example.com",
    }), "unmatched");
    const count = await db.prepare("SELECT COUNT(*) AS count FROM suppressions").first<{ count: number }>();
    assert.equal(count?.count, 0);
  } finally { db.close(); }
});
