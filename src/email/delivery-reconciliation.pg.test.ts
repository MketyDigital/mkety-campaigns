import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PostgresEmailEventReconciler } from "./delivery-reconciliation.js";

test("PostgreSQL delivery events are idempotent and suppress the matched tenant", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const tenantId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const contactId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const providerMessageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const email = `test-${crypto.randomUUID()}@example.com`;
  try {
    await pool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, 'Reconciliation integration test', 'approved')",
      [tenantId],
    );
    await pool.query(
      "INSERT INTO contacts (id, tenant_id, email) VALUES ($1, $2, $3)",
      [contactId, tenantId, email],
    );
    await pool.query(
      "INSERT INTO campaigns (id, tenant_id, channel, status, body_text) VALUES ($1, $2, 'email', 'sent', 'Integration test')",
      [campaignId, tenantId],
    );
    await pool.query(
      `INSERT INTO delivery_attempts
       (id, tenant_id, campaign_id, contact_id, channel, provider, provider_message_id, status, idempotency_key)
       VALUES ($1, $2, $3, $4, 'email', 'acs-email', $5, 'accepted', $6)`,
      [attemptId, tenantId, campaignId, contactId, providerMessageId, crypto.randomUUID()],
    );

    const reconciler = new PostgresEmailEventReconciler(pool);
    const event = {
      provider: "acs-email", providerMessageId, eventId, outcome: "bounced",
      occurredAt: "2026-11-10T18:00:00Z",
    };
    assert.equal(await reconciler.reconcile(event), "recorded");
    assert.equal(await reconciler.reconcile(event), "duplicate");

    const stored = await pool.query<{ status: string; last_event_at: Date }>(
      "SELECT status, last_event_at FROM delivery_attempts WHERE id = $1", [attemptId],
    );
    assert.equal(stored.rows[0]?.status, "bounced");
    assert.equal(stored.rows[0]?.last_event_at.toISOString(), "2026-11-10T18:00:00.000Z");
    const suppression = await pool.query<{ reason: string; source: string }>(
      "SELECT reason, source FROM suppressions WHERE tenant_id = $1 AND channel = 'email' AND address_normalized = $2",
      [tenantId, email],
    );
    assert.deepEqual(suppression.rows.map(({ reason, source }) => ({ reason, source })),
      [{ reason: "bounced", source: "acs-email" }]);
    const events = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM email_delivery_events WHERE provider = 'acs-email' AND delivery_attempt_id = $1",
      [attemptId],
    );
    assert.equal(events.rows[0]?.count, "1");

    assert.equal(await reconciler.reconcile({
      ...event, eventId: crypto.randomUUID(), outcome: "delivered", occurredAt: "2026-11-10T19:00:00Z",
    }), "recorded");
    const finalAttempt = await pool.query<{ status: string }>(
      "SELECT status FROM delivery_attempts WHERE id = $1", [attemptId],
    );
    assert.equal(finalAttempt.rows[0]?.status, "bounced", "a late delivery must not undo the bounce");
  } finally {
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await pool.end();
  }
});

test("PostgreSQL ignores unknown messages and refuses ambiguous provider identifiers", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const tenantId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const contactIds = [crypto.randomUUID(), crypto.randomUUID()];
  const messageId = crypto.randomUUID();
  try {
    await pool.query("INSERT INTO tenants (id, name, status) VALUES ($1, 'Ambiguous message test', 'approved')", [tenantId]);
    await pool.query("INSERT INTO campaigns (id, tenant_id, channel, status, body_text) VALUES ($1, $2, 'email', 'sent', 'Test')", [campaignId, tenantId]);
    const reconciler = new PostgresEmailEventReconciler(pool);
    const event = {
      provider: "oci-email-delivery", providerMessageId: messageId,
      eventId: crypto.randomUUID(), outcome: "complained", occurredAt: "2026-11-10T18:00:00Z",
    };
    assert.equal(await reconciler.reconcile(event), "unmatched");
    for (const [index, contactId] of contactIds.entries()) {
      await pool.query("INSERT INTO contacts (id, tenant_id, email) VALUES ($1, $2, $3)",
        [contactId, tenantId, `person${index}-${crypto.randomUUID()}@example.com`]);
      await pool.query(
        `INSERT INTO delivery_attempts (id, tenant_id, campaign_id, contact_id, channel, provider, provider_message_id, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'email', 'oci-email-delivery', $5, 'accepted', $6)`,
        [crypto.randomUUID(), tenantId, campaignId, contactId, messageId, crypto.randomUUID()],
      );
    }
    await assert.rejects(() => reconciler.reconcile(event), /Ambiguous provider delivery message ID/);
    const blocked = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM suppressions WHERE tenant_id = $1", [tenantId],
    );
    assert.equal(blocked.rows[0]?.count, "0");
  } finally {
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await pool.end();
  }
});
