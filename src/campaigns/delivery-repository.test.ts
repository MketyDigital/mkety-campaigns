import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { D1CampaignDispatchRepository } from "./delivery-repository.js";
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

async function seedCampaign(db: SqliteD1, recipientCount = 1) {
  const exec = async (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).bind(...args).run();
  await exec("INSERT INTO tenants (id, name, status) VALUES ('tenant-1', 'Example', 'approved')");
  await exec("INSERT INTO users (id, email, display_name, role, two_factor_enabled, mfa_enrolled_at) VALUES ('ops-1', 'ops@example.com', 'Ops', 'ops', 1, CURRENT_TIMESTAMP)");
  await exec("INSERT INTO tenant_email_domains (id, tenant_id, domain_name, provisioning_state, linked) VALUES ('domain-1', 'tenant-1', 'mail.example.com', 'Succeeded', 1)");
  await exec("INSERT INTO tenant_sender_identities (id, tenant_id, domain_id, sender_address, display_name, provider, status) VALUES ('sender-1', 'tenant-1', 'domain-1', 'info@mail.example.com', 'Updates', 'acs-email', 'ready')");
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
