import type { PostgresPool } from "./repository.js";
import type { CampaignDeliveryJob, CampaignDeliveryRepository } from "./delivery.js";
import type { EmailSendResult } from "../email/providers.js";
import { buildUnsubscribeUrl, createOpaqueUnsubscribeToken } from "../email/unsubscribe.js";

export interface CampaignDispatchRepository extends CampaignDeliveryRepository {
  queueApproved(campaignId: string, actorUserId: string, maxRecipients: number): Promise<number>;
}

export class CampaignDispatchConflictError extends Error {
  constructor(message: string) { super(message); this.name = "CampaignDispatchConflictError"; }
}

export class PostgresCampaignDispatchRepository implements CampaignDispatchRepository {
  constructor(private readonly database: PostgresPool, private readonly publicBaseUrl: string) {
    validateDispatchSettings(publicBaseUrl);
  }

  async queueApproved(campaignId: string, actorUserId: string, maxRecipients: number): Promise<number> {
    const limit = normalizeRecipientLimit(maxRecipients);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<DispatchCampaignRow>(
        `SELECT id, tenant_id, channel, status, sender_identity_id, scheduled_at
           FROM campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
      const campaign = selected.rows[0];
      assertQueueable(campaign);
      const sender = await client.query<{ id: string }>(
        `SELECT id FROM tenant_sender_identities
          WHERE id = $1 AND tenant_id = $2 AND status = 'ready' AND provider = 'acs-email'`,
        [campaign.sender_identity_id, campaign.tenant_id]);
      if (!sender.rows.length) throw new CampaignDispatchConflictError("Campaign sender is not ready");
      const contacts = await client.query<{ id: string }>(`${eligibleContactsSql("$1")} ORDER BY ct.created_at, ct.id LIMIT $2`, [campaign.tenant_id, limit + 1]);
      if (!contacts.rows.length) throw new CampaignDispatchConflictError("Campaign has no eligible email recipients");
      if (contacts.rows.length > limit) throw new CampaignDispatchConflictError("Campaign exceeds the configured recipient limit");
      for (const contact of contacts.rows) {
        await client.query(
          `INSERT INTO campaign_jobs (id, tenant_id, campaign_id, contact_id, status, idempotency_key, available_at)
           VALUES ($1, $2, $3, $4, 'queued', $5, COALESCE($6, NOW()))
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [crypto.randomUUID(), campaign.tenant_id, campaign.id, contact.id, `campaign:${campaign.id}:contact:${contact.id}`, campaign.scheduled_at]);
        await client.query(
          `INSERT INTO unsubscribe_tokens (token, tenant_id, campaign_id, contact_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [createOpaqueUnsubscribeToken(), campaign.tenant_id, campaign.id, contact.id]);
      }
      await client.query("UPDATE campaigns SET status = 'queued', updated_at = NOW() WHERE id = $1 AND status = 'approved'", [campaign.id]);
      await client.query(
        `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata_json)
         VALUES ($1, $2, $3, 'campaign_queued', 'campaign', $4, $5)`,
        [crypto.randomUUID(), campaign.tenant_id, actorUserId, campaign.id, JSON.stringify({ recipients: contacts.rows.length })]);
      await client.query("COMMIT");
      return contacts.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(): Promise<CampaignDeliveryJob | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE campaign_jobs SET status = 'uncertain', locked_at = NULL,
             last_error = 'Worker lease expired; reconcile before retrying.'
          WHERE status = 'sending' AND locked_at < NOW() - INTERVAL '5 minutes'`);
      await client.query(suppressIneligibleJobsSql("NOW()"));
      const result = await client.query<DeliveryJobRow>(
        `SELECT cj.id, cj.tenant_id, cj.campaign_id, cj.contact_id, cj.idempotency_key,
                si.sender_address, ct.email, c.subject, c.body_text, c.body_html, ut.token AS unsubscribe_token
           FROM campaign_jobs cj
           JOIN campaigns c ON c.id = cj.campaign_id AND c.tenant_id = cj.tenant_id
           JOIN contacts ct ON ct.id = cj.contact_id AND ct.tenant_id = cj.tenant_id
           JOIN tenant_sender_identities si ON si.id = c.sender_identity_id AND si.tenant_id = cj.tenant_id
          JOIN unsubscribe_tokens ut ON ut.campaign_id = cj.campaign_id AND ut.contact_id = cj.contact_id AND ut.tenant_id = cj.tenant_id
          WHERE cj.status = 'queued' AND cj.available_at <= NOW() AND c.status = 'queued'
            AND c.channel = 'email' AND si.status = 'ready' AND si.provider = 'acs-email'
            AND ${activeConsentSql("cj", "ct")}
            AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.tenant_id = cj.tenant_id AND sp.channel = 'email' AND sp.address_normalized = LOWER(ct.email))
          ORDER BY cj.available_at, cj.created_at
          FOR UPDATE OF cj SKIP LOCKED LIMIT 1`);
      const row = result.rows[0];
      if (!row) {
        await finalizeCampaigns(client);
        await client.query("COMMIT");
        return null;
      }
      await client.query("UPDATE campaign_jobs SET status = 'sending', locked_at = NOW(), attempts = attempts + 1 WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      return mapDeliveryJob(row, buildUnsubscribeUrl(this.publicBaseUrl, row.unsubscribe_token).href);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAccepted(id: string, result: EmailSendResult): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<DeliveryStateRow>(
        `UPDATE campaign_jobs SET status = 'accepted', locked_at = NULL, last_error = NULL
          WHERE id = $1 AND status = 'sending'
          RETURNING tenant_id, campaign_id, contact_id, idempotency_key`, [id]);
      const accepted = job.rows[0];
      if (accepted) await client.query(
        `INSERT INTO delivery_attempts (id, tenant_id, campaign_id, contact_id, channel, provider, provider_message_id, status, idempotency_key, accepted_at)
         VALUES ($1, $2, $3, $4, 'email', $5, $6, 'accepted', $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [crypto.randomUUID(), accepted.tenant_id, accepted.campaign_id, accepted.contact_id, result.provider, result.providerMessageId ?? null, accepted.idempotency_key, result.acceptedAt]);
      if (accepted) await finalizeCampaigns(client, accepted.campaign_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markUncertain(id: string, reason: string): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<DeliveryStateRow>(
        `UPDATE campaign_jobs SET status = 'uncertain', locked_at = NULL, last_error = $2
          WHERE id = $1 AND status = 'sending'
          RETURNING tenant_id, campaign_id, contact_id, idempotency_key`, [id, safeReason(reason)]);
      const uncertain = job.rows[0];
      if (uncertain) {
        await client.query(
          `INSERT INTO delivery_attempts (id, tenant_id, campaign_id, contact_id, channel, provider, status, idempotency_key, last_error)
           SELECT $1, $2, $3, $4, 'email', si.provider, 'uncertain', $5, $6
             FROM campaigns c JOIN tenant_sender_identities si ON si.id = c.sender_identity_id
            WHERE c.id = $3
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [crypto.randomUUID(), uncertain.tenant_id, uncertain.campaign_id, uncertain.contact_id, uncertain.idempotency_key, safeReason(reason)]);
        await finalizeCampaigns(client, uncertain.campaign_id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class D1CampaignDispatchRepository implements CampaignDispatchRepository {
  constructor(private readonly database: D1Database, private readonly publicBaseUrl: string) {
    validateDispatchSettings(publicBaseUrl);
  }

  async queueApproved(campaignId: string, actorUserId: string, maxRecipients: number): Promise<number> {
    const limit = normalizeRecipientLimit(maxRecipients);
    const campaign = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, scheduled_at FROM campaigns WHERE id = ?1`,
    ).bind(campaignId).first<DispatchCampaignRow>();
    assertQueueable(campaign);
    const sender = await this.database.prepare(
      `SELECT id FROM tenant_sender_identities WHERE id = ?1 AND tenant_id = ?2 AND status = 'ready' AND provider = 'acs-email'`,
    ).bind(campaign.sender_identity_id, campaign.tenant_id).first<{ id: string }>();
    if (!sender) throw new CampaignDispatchConflictError("Campaign sender is not ready");
    const contacts = await this.database.prepare(`${eligibleContactsSql("?1")} ORDER BY ct.created_at, ct.id LIMIT ?2`)
      .bind(campaign.tenant_id, limit + 1).all<{ id: string }>();
    const rows = contacts.results ?? [];
    if (!rows.length) throw new CampaignDispatchConflictError("Campaign has no eligible email recipients");
    if (rows.length > limit) throw new CampaignDispatchConflictError("Campaign exceeds the configured recipient limit");
    const statements = rows.flatMap((contact) => [
      this.database.prepare(
        `INSERT INTO campaign_jobs (id, tenant_id, campaign_id, contact_id, status, idempotency_key, available_at)
         VALUES (?1, ?2, ?3, ?4, 'queued', ?5, COALESCE(?6, CURRENT_TIMESTAMP)) ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(crypto.randomUUID(), campaign.tenant_id, campaign.id, contact.id, `campaign:${campaign.id}:contact:${contact.id}`, campaign.scheduled_at),
      this.database.prepare(
        `INSERT INTO unsubscribe_tokens (token, tenant_id, campaign_id, contact_id) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(campaign_id, contact_id) DO NOTHING`,
      ).bind(createOpaqueUnsubscribeToken(), campaign.tenant_id, campaign.id, contact.id),
    ]);
    statements.push(this.database.prepare("UPDATE campaigns SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND status = 'approved'").bind(campaign.id));
    statements.push(this.database.prepare(
      `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata_json)
       VALUES (?1, ?2, ?3, 'campaign_queued', 'campaign', ?4, ?5)`,
    ).bind(crypto.randomUUID(), campaign.tenant_id, actorUserId, campaign.id, JSON.stringify({ recipients: rows.length })));
    await this.database.batch(statements);
    return rows.length;
  }

  async claimNext(): Promise<CampaignDeliveryJob | null> {
    await this.database.prepare(
      `UPDATE campaign_jobs SET status = 'uncertain', locked_at = NULL, last_error = 'Worker lease expired; reconcile before retrying.'
        WHERE status = 'sending' AND locked_at < datetime('now', '-5 minutes')`,
    ).run();
    await this.database.prepare(suppressIneligibleJobsSql("CURRENT_TIMESTAMP", true)).run();
    const claimed = await this.database.prepare(
      `UPDATE campaign_jobs SET status = 'sending', locked_at = CURRENT_TIMESTAMP, attempts = attempts + 1
        WHERE id = (SELECT cj.id FROM campaign_jobs cj
          JOIN campaigns c ON c.id = cj.campaign_id AND c.tenant_id = cj.tenant_id
          JOIN contacts ct ON ct.id = cj.contact_id AND ct.tenant_id = cj.tenant_id
          JOIN tenant_sender_identities si ON si.id = c.sender_identity_id AND si.tenant_id = cj.tenant_id
          WHERE cj.status = 'queued' AND cj.available_at <= CURRENT_TIMESTAMP AND c.status = 'queued'
            AND c.channel = 'email' AND si.status = 'ready' AND si.provider = 'acs-email'
            AND ${activeConsentSql("cj", "ct")}
            AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.tenant_id = cj.tenant_id AND sp.channel = 'email' AND sp.address_normalized = LOWER(ct.email))
          ORDER BY cj.available_at, cj.created_at LIMIT 1)
        AND status = 'queued' RETURNING id`,
    ).first<{ id: string }>();
    if (!claimed) {
      await this.database.prepare(
        `UPDATE campaigns SET status = CASE WHEN EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = campaigns.id AND status = 'uncertain') THEN 'needs_review' ELSE 'sent' END, updated_at = CURRENT_TIMESTAMP
          WHERE status = 'queued' AND EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = campaigns.id)
            AND NOT EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = campaigns.id AND status IN ('queued','sending'))`,
      ).run();
      return null;
    }
    const row = await this.database.prepare(
      `SELECT cj.id, cj.tenant_id, cj.campaign_id, cj.contact_id, cj.idempotency_key,
              si.sender_address, ct.email, c.subject, c.body_text, c.body_html, ut.token AS unsubscribe_token
         FROM campaign_jobs cj JOIN campaigns c ON c.id = cj.campaign_id AND c.tenant_id = cj.tenant_id
         JOIN contacts ct ON ct.id = cj.contact_id AND ct.tenant_id = cj.tenant_id
         JOIN tenant_sender_identities si ON si.id = c.sender_identity_id AND si.tenant_id = cj.tenant_id
         JOIN unsubscribe_tokens ut ON ut.campaign_id = cj.campaign_id AND ut.contact_id = cj.contact_id AND ut.tenant_id = cj.tenant_id
        WHERE cj.id = ?1 AND cj.status = 'sending'`,
    ).bind(claimed.id).first<DeliveryJobRow>();
    return row ? mapDeliveryJob(row, buildUnsubscribeUrl(this.publicBaseUrl, row.unsubscribe_token).href) : null;
  }

  async markAccepted(id: string, result: EmailSendResult): Promise<void> {
    await this.database.batch([
      this.database.prepare(`UPDATE campaign_jobs SET status = 'accepted', locked_at = NULL, last_error = NULL WHERE id = ?1 AND status = 'sending'`).bind(id),
      this.database.prepare(
        `INSERT INTO delivery_attempts (id, tenant_id, campaign_id, contact_id, channel, provider, provider_message_id, status, idempotency_key, accepted_at)
         SELECT ?1, tenant_id, campaign_id, contact_id, 'email', ?2, ?3, 'accepted', idempotency_key, ?4 FROM campaign_jobs WHERE id = ?5 AND status = 'accepted'
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(crypto.randomUUID(), result.provider, result.providerMessageId ?? null, result.acceptedAt, id),
      this.database.prepare(`UPDATE campaigns SET status = CASE WHEN EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = (SELECT campaign_id FROM campaign_jobs WHERE id = ?1) AND status = 'uncertain') THEN 'needs_review' ELSE 'sent' END, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT campaign_id FROM campaign_jobs WHERE id = ?1) AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = (SELECT campaign_id FROM campaign_jobs WHERE id = ?1) AND status IN ('queued','sending'))`).bind(id),
    ]);
  }

  async markUncertain(id: string, reason: string): Promise<void> {
    const safe = safeReason(reason);
    await this.database.batch([
      this.database.prepare(`UPDATE campaign_jobs SET status = 'uncertain', locked_at = NULL, last_error = ?2 WHERE id = ?1 AND status = 'sending'`).bind(id, safe),
      this.database.prepare(
        `INSERT INTO delivery_attempts (id, tenant_id, campaign_id, contact_id, channel, provider, status, idempotency_key, last_error)
         SELECT ?1, cj.tenant_id, cj.campaign_id, cj.contact_id, 'email', si.provider, 'uncertain', cj.idempotency_key, ?2
           FROM campaign_jobs cj JOIN campaigns c ON c.id = cj.campaign_id JOIN tenant_sender_identities si ON si.id = c.sender_identity_id
          WHERE cj.id = ?3 AND cj.status = 'uncertain' ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(crypto.randomUUID(), safe, id),
      this.database.prepare(`UPDATE campaigns SET status = 'needs_review', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT campaign_id FROM campaign_jobs WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM campaign_jobs WHERE campaign_id = (SELECT campaign_id FROM campaign_jobs WHERE id = ?1) AND status IN ('queued','sending'))`).bind(id),
    ]);
  }
}

type DispatchCampaignRow = { id: string; tenant_id: string; channel: string; status: string; sender_identity_id: string | null; scheduled_at: string | Date | null };
type DeliveryJobRow = { id: string; tenant_id: string; campaign_id: string; contact_id: string; idempotency_key: string; sender_address: string; email: string; subject: string; body_text: string; body_html: string | null; unsubscribe_token: string };
type DeliveryStateRow = { tenant_id: string; campaign_id: string; contact_id: string; idempotency_key: string };

function assertQueueable(campaign: DispatchCampaignRow | null): asserts campaign is DispatchCampaignRow {
  if (!campaign || campaign.status !== "approved") throw new CampaignDispatchConflictError("Campaign is not approved for dispatch");
  if (campaign.channel !== "email") throw new CampaignDispatchConflictError("SMS campaign dispatch is disabled");
  if (!campaign.sender_identity_id) throw new CampaignDispatchConflictError("Campaign sender is not selected");
}

function normalizeRecipientLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new CampaignDispatchConflictError("Campaign recipient limit must be 1 to 1000");
  return value;
}

function validateDispatchSettings(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("BETTER_AUTH_URL must use HTTPS outside localhost");
}

function eligibleContactsSql(tenantPlaceholder: string): string {
  return `SELECT ct.id FROM contacts ct WHERE ct.tenant_id = ${tenantPlaceholder} AND ct.email IS NOT NULL
    AND ${activeConsentSql("", "ct")}
    AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.tenant_id = ct.tenant_id AND sp.channel = 'email' AND sp.address_normalized = LOWER(ct.email))`;
}

function activeConsentSql(jobAlias: string, contactAlias: string): string {
  const tenant = jobAlias ? `${jobAlias}.tenant_id` : `${contactAlias}.tenant_id`;
  const contactId = jobAlias ? `${jobAlias}.contact_id` : `${contactAlias}.id`;
  return `(SELECT cr.state FROM consent_records cr WHERE cr.tenant_id = ${tenant} AND cr.contact_id = ${contactId} AND cr.channel = 'email' ORDER BY cr.occurred_at DESC, cr.id DESC LIMIT 1) = 'granted'`;
}

function suppressIneligibleJobsSql(now: string, sqlite = false): string {
  return `UPDATE campaign_jobs${sqlite ? " AS" : ""} cj SET status = 'suppressed', locked_at = NULL
    WHERE cj.status = 'queued' AND cj.available_at <= ${now}
      AND EXISTS (SELECT 1 FROM campaigns c WHERE c.id = cj.campaign_id AND c.status = 'queued')
      AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = cj.contact_id AND ct.tenant_id = cj.tenant_id
        AND ct.email IS NOT NULL AND ${activeConsentSql("cj", "ct")}
        AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.tenant_id = cj.tenant_id AND sp.channel = 'email' AND sp.address_normalized = LOWER(ct.email)))`;
}

function mapDeliveryJob(row: DeliveryJobRow, unsubscribeUrl: string): CampaignDeliveryJob {
  return {
    id: row.id, tenantId: row.tenant_id, campaignId: row.campaign_id, contactId: row.contact_id,
    idempotencyKey: row.idempotency_key, from: row.sender_address, to: row.email,
    subject: row.subject, bodyText: row.body_text, ...(row.body_html ? { bodyHtml: row.body_html } : {}), unsubscribeUrl,
  };
}

async function finalizeCampaigns(client: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, campaignId?: string): Promise<void> {
  await client.query(
    `UPDATE campaigns c SET status = CASE WHEN EXISTS (SELECT 1 FROM campaign_jobs cj WHERE cj.campaign_id = c.id AND cj.status = 'uncertain') THEN 'needs_review' ELSE 'sent' END, updated_at = NOW()
      WHERE c.status = 'queued' AND ($1::text IS NULL OR c.id = $1)
        AND NOT EXISTS (SELECT 1 FROM campaign_jobs cj WHERE cj.campaign_id = c.id AND cj.status IN ('queued','sending'))`, [campaignId ?? null]);
}

function safeReason(reason: string): string {
  return reason.toLowerCase().includes("uncertain") ? "Provider outcome is uncertain; reconcile before retrying." : "Delivery status requires operator review.";
}
