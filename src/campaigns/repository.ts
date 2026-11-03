import type { CampaignChannel, CampaignDraft, ValidContactImport } from "./service.js";
import type { CampaignSummary, CampaignWorkspace, ContactSummary } from "./workspace.js";

type QueryResult<T> = { rows: T[] };
interface Queryable {
  query<T = Record<string, unknown>>(query: string, parameters?: unknown[]): Promise<QueryResult<T>>;
}
interface TransactionClient extends Queryable { release(): void }
export interface PostgresPool extends Queryable { connect(): Promise<TransactionClient> }

type ContactRow = { id: string; email: string | null; phone_e164: string | null; display_name: string | null; created_at: Date | string };
type CampaignRow = { id: string; tenant_id: string; channel: CampaignChannel; status: string; sender_identity_id: string | null; subject: string | null; body_html: string | null; body_text: string; scheduled_at: Date | string | null; created_at: Date | string };

export class PostgresCampaignWorkspace implements CampaignWorkspace {
  constructor(private readonly database: PostgresPool) {}

  async listContacts(tenantId: string): Promise<ContactSummary[]> {
    const result = await this.database.query<ContactRow>(
      `SELECT id, email, phone_e164, display_name, created_at
         FROM contacts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`, [tenantId]);
    return result.rows.map(mapContact);
  }

  async importContacts(tenantId: string, channel: CampaignChannel, rows: ValidContactImport[]): Promise<{ imported: number }> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        const matches = await client.query<{ id: string }>(
          `SELECT id FROM contacts WHERE tenant_id = $1
             AND (($2::text IS NOT NULL AND email = $2) OR ($3::text IS NOT NULL AND phone_e164 = $3))
           FOR UPDATE`, [tenantId, row.email, row.phoneE164]);
        if (matches.rows.length > 1) throw new Error("Contact email and phone already belong to different records");
        const contactId = matches.rows[0]?.id ?? crypto.randomUUID();
        if (matches.rows[0]) {
          await client.query(
            `UPDATE contacts SET email = COALESCE($3, email), phone_e164 = COALESCE($4, phone_e164),
                 display_name = COALESCE($5, display_name)
              WHERE tenant_id = $1 AND id = $2`,
            [tenantId, contactId, row.email, row.phoneE164, row.displayName]);
        } else {
          await client.query(
            `INSERT INTO contacts (id, tenant_id, email, phone_e164, display_name)
             VALUES ($1, $2, $3, $4, $5)`, [contactId, tenantId, row.email, row.phoneE164, row.displayName]);
        }
        await client.query(
          `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
           VALUES ($1, $2, $3, $4, 'granted', $5, $6, $7)
           ON CONFLICT (tenant_id, contact_id, channel, source, evidence_ref) WHERE evidence_ref IS NOT NULL DO NOTHING`,
          [crypto.randomUUID(), tenantId, contactId, channel, row.consent.source, row.consent.evidenceRef, row.consent.occurredAt]);
      }
      await client.query("COMMIT");
      return { imported: rows.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCampaigns(tenantId: string): Promise<CampaignSummary[]> {
    const result = await this.database.query<CampaignRow>(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
    return result.rows.map(mapCampaign);
  }

  async createCampaign(tenantId: string, draft: CampaignDraft): Promise<CampaignSummary> {
    const id = crypto.randomUUID();
    const result = await this.database.query<CampaignRow>(
      `INSERT INTO campaigns (id, tenant_id, channel, sender_identity_id, subject, body_html, body_text, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at`,
      [id, tenantId, draft.channel, draft.senderIdentityId ?? null, draft.subject ?? null, draft.bodyHtml ?? null, draft.bodyText, draft.scheduledAt ?? null]);
    if (!result.rows[0]) throw new Error("Campaign was not saved");
    return mapCampaign(result.rows[0]);
  }

  async submitForReview(tenantId: string, campaignId: string): Promise<CampaignSummary | null> {
    const result = await this.database.query<CampaignRow>(
      `UPDATE campaigns SET status = 'in_review', updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
        RETURNING id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at`,
      [tenantId, campaignId]);
    return result.rows[0] ? mapCampaign(result.rows[0]) : null;
  }

  async listCampaignsInReview(): Promise<CampaignSummary[]> {
    const result = await this.database.query<CampaignRow>(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE status = 'in_review' ORDER BY created_at ASC LIMIT 100`);
    return result.rows.map(mapCampaign);
  }

  async listApprovedCampaigns(): Promise<CampaignSummary[]> {
    const result = await this.database.query<CampaignRow>(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE status = 'approved' ORDER BY updated_at ASC LIMIT 100`);
    return result.rows.map(mapCampaign);
  }

  async reviewCampaign(campaignId: string, reviewerUserId: string, decision: "approve" | "reject"): Promise<CampaignSummary | null> {
    const status = decision === "approve" ? "approved" : "rejected";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CampaignRow>(
        `UPDATE campaigns SET status = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3 ELSE NULL END, updated_at = NOW()
          WHERE id = $1 AND status = 'in_review'
          RETURNING id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at`,
        [campaignId, status, reviewerUserId]);
      const row = result.rows[0];
      if (row) await client.query(
        `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata_json)
         VALUES ($1, $2, $3, $4, 'campaign', $5, $6)`,
        [crypto.randomUUID(), row.tenant_id, reviewerUserId, auditAction(decision), campaignId, JSON.stringify({ deliveryQueued: false })]);
      await client.query("COMMIT");
      return row ? mapCampaign(row) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withdrawConsent(tenantId: string, contactId: string, channel: CampaignChannel): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const column = channel === "email" ? "email" : "phone_e164";
      const contact = await client.query<{ address: string | null }>(
        `SELECT ${column} AS address FROM contacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, contactId]);
      const address = contact.rows[0]?.address;
      if (!address) { await client.query("ROLLBACK"); return false; }
      const normalizedAddress = channel === "email" ? address.toLowerCase() : address;
      await client.query(
        `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
         VALUES ($1, $2, $3, $4, 'withdrawn', 'workspace', $5, NOW())`,
        [crypto.randomUUID(), tenantId, contactId, channel, crypto.randomUUID()]);
      await client.query(
        `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
         VALUES ($1, $2, $3, 'opt_out', 'workspace')
         ON CONFLICT (tenant_id, channel, address_normalized) DO UPDATE SET reason = 'opt_out', source = 'workspace', created_at = NOW()`,
        [tenantId, channel, normalizedAddress]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async unsubscribe(token: string): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ tenant_id: string; contact_id: string; email: string | null; used_at: Date | null }>(
        `SELECT u.tenant_id, u.contact_id, ct.email, u.used_at FROM unsubscribe_tokens u
          JOIN contacts ct ON ct.id = u.contact_id AND ct.tenant_id = u.tenant_id
         WHERE u.token = $1 FOR UPDATE OF u`, [token]);
      const row = result.rows[0];
      if (!row || !row.email) { await client.query("ROLLBACK"); return false; }
      if (!row.used_at) {
        await client.query(
          `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
           VALUES ($1, $2, $3, 'email', 'withdrawn', 'one_click_unsubscribe', $4, NOW())`,
          [crypto.randomUUID(), row.tenant_id, row.contact_id, crypto.randomUUID()]);
        await client.query(
          `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
           VALUES ($1, 'email', LOWER($2), 'opt_out', 'one_click_unsubscribe')
           ON CONFLICT (tenant_id, channel, address_normalized) DO UPDATE SET reason = 'opt_out', source = 'one_click_unsubscribe', created_at = NOW()`,
          [row.tenant_id, row.email]);
        await client.query("UPDATE unsubscribe_tokens SET used_at = NOW() WHERE token = $1", [token]);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class D1CampaignWorkspace implements CampaignWorkspace {
  constructor(private readonly database: D1Database) {}

  async listContacts(tenantId: string): Promise<ContactSummary[]> {
    const result = await this.database.prepare(
      `SELECT id, email, phone_e164, display_name, created_at
         FROM contacts WHERE tenant_id = ?1 ORDER BY created_at DESC LIMIT 500`,
    ).bind(tenantId).all<ContactRow>();
    return (result.results ?? []).map(mapContact);
  }

  async importContacts(tenantId: string, channel: CampaignChannel, rows: ValidContactImport[]): Promise<{ imported: number }> {
    for (const row of rows) {
      const matches = await this.database.prepare(
        `SELECT id FROM contacts WHERE tenant_id = ?1
           AND ((?2 IS NOT NULL AND email = ?2) OR (?3 IS NOT NULL AND phone_e164 = ?3))`,
      ).bind(tenantId, row.email, row.phoneE164).all<{ id: string }>();
      if ((matches.results ?? []).length > 1) throw new Error("Contact email and phone already belong to different records");
      const id = matches.results?.[0]?.id ?? crypto.randomUUID();
      const contact = matches.results?.[0]
        ? this.database.prepare(
          `UPDATE contacts SET email = COALESCE(?3, email), phone_e164 = COALESCE(?4, phone_e164),
             display_name = COALESCE(?5, display_name) WHERE tenant_id = ?1 AND id = ?2`,
        ).bind(tenantId, id, row.email, row.phoneE164, row.displayName)
        : this.database.prepare(
          `INSERT INTO contacts (id, tenant_id, email, phone_e164, display_name) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(id, tenantId, row.email, row.phoneE164, row.displayName);
      const consent = this.database.prepare(
        `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
         VALUES (?1, ?2, ?3, ?4, 'granted', ?5, ?6, ?7)
         ON CONFLICT (tenant_id, contact_id, channel, source, evidence_ref) WHERE evidence_ref IS NOT NULL DO NOTHING`,
      ).bind(crypto.randomUUID(), tenantId, id, channel, row.consent.source, row.consent.evidenceRef, row.consent.occurredAt);
      await this.database.batch([contact, consent]);
    }
    return { imported: rows.length };
  }

  async listCampaigns(tenantId: string): Promise<CampaignSummary[]> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE tenant_id = ?1 ORDER BY created_at DESC LIMIT 100`,
    ).bind(tenantId).all<CampaignRow>();
    return (result.results ?? []).map(mapCampaign);
  }

  async createCampaign(tenantId: string, draft: CampaignDraft): Promise<CampaignSummary> {
    const id = crypto.randomUUID();
    await this.database.prepare(
      `INSERT INTO campaigns (id, tenant_id, channel, sender_identity_id, subject, body_html, body_text, scheduled_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, tenantId, draft.channel, draft.senderIdentityId ?? null, draft.subject ?? null, draft.bodyHtml ?? null, draft.bodyText, draft.scheduledAt ?? null).run();
    const row = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, id).first<CampaignRow>();
    if (!row) throw new Error("Campaign was not saved");
    return mapCampaign(row);
  }

  async submitForReview(tenantId: string, campaignId: string): Promise<CampaignSummary | null> {
    const result = await this.database.prepare(
      `UPDATE campaigns SET status = 'in_review', updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?1 AND id = ?2 AND status = 'draft'`,
    ).bind(tenantId, campaignId).run();
    if (!result.meta.changes) return null;
    const row = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, campaignId).first<CampaignRow>();
    return row ? mapCampaign(row) : null;
  }

  async listCampaignsInReview(): Promise<CampaignSummary[]> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE status = 'in_review' ORDER BY created_at ASC LIMIT 100`,
    ).all<CampaignRow>();
    return (result.results ?? []).map(mapCampaign);
  }

  async listApprovedCampaigns(): Promise<CampaignSummary[]> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at
         FROM campaigns WHERE status = 'approved' ORDER BY updated_at ASC LIMIT 100`,
    ).all<CampaignRow>();
    return (result.results ?? []).map(mapCampaign);
  }

  async reviewCampaign(campaignId: string, reviewerUserId: string, decision: "approve" | "reject"): Promise<CampaignSummary | null> {
    const status = decision === "approve" ? "approved" : "rejected";
    const existing = await this.database.prepare(
      `SELECT tenant_id FROM campaigns WHERE id = ?1 AND status = 'in_review'`,
    ).bind(campaignId).first<{ tenant_id: string }>();
    if (!existing) return null;
    const update = this.database.prepare(
      `UPDATE campaigns SET status = ?2, approved_by = CASE WHEN ?2 = 'approved' THEN ?3 ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1 AND status = 'in_review'`,
    ).bind(campaignId, status, reviewerUserId);
    const audit = this.database.prepare(
      `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata_json)
       SELECT ?1, ?2, ?3, ?4, 'campaign', ?5, ?6 WHERE changes() > 0`,
    ).bind(crypto.randomUUID(), existing.tenant_id, reviewerUserId, auditAction(decision), campaignId, JSON.stringify({ deliveryQueued: false }));
    const results = await this.database.batch([update, audit]);
    if (!results[0]?.meta.changes) return null;
    const row = await this.database.prepare(
      `SELECT id, tenant_id, channel, status, sender_identity_id, subject, body_html, body_text, scheduled_at, created_at FROM campaigns WHERE id = ?1`,
    ).bind(campaignId).first<CampaignRow>();
    return row ? mapCampaign(row) : null;
  }

  async withdrawConsent(tenantId: string, contactId: string, channel: CampaignChannel): Promise<boolean> {
    const column = channel === "email" ? "email" : "phone_e164";
    const contact = await this.database.prepare(
      `SELECT ${column} AS address FROM contacts WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, contactId).first<{ address: string | null }>();
    if (!contact?.address) return false;
    const normalizedAddress = channel === "email" ? contact.address.toLowerCase() : contact.address;
    const evidenceRef = crypto.randomUUID();
    const consent = this.database.prepare(
      `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
       VALUES (?1, ?2, ?3, ?4, 'withdrawn', 'workspace', ?5, CURRENT_TIMESTAMP)`,
    ).bind(crypto.randomUUID(), tenantId, contactId, channel, evidenceRef);
    const suppression = this.database.prepare(
      `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
       VALUES (?1, ?2, ?3, 'opt_out', 'workspace')
       ON CONFLICT (tenant_id, channel, address_normalized) DO UPDATE SET reason = 'opt_out', source = 'workspace', created_at = CURRENT_TIMESTAMP`,
    ).bind(tenantId, channel, normalizedAddress);
    await this.database.batch([consent, suppression]);
    return true;
  }

  async unsubscribe(token: string): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT u.tenant_id, u.contact_id, ct.email, u.used_at FROM unsubscribe_tokens u
        JOIN contacts ct ON ct.id = u.contact_id AND ct.tenant_id = u.tenant_id WHERE u.token = ?1`,
    ).bind(token).first<{ tenant_id: string; contact_id: string; email: string | null; used_at: string | null }>();
    if (!row?.email) return false;
    if (!row.used_at) {
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO consent_records (id, tenant_id, contact_id, channel, state, source, evidence_ref, occurred_at)
           VALUES (?1, ?2, ?3, 'email', 'withdrawn', 'one_click_unsubscribe', ?4, CURRENT_TIMESTAMP)`,
        ).bind(crypto.randomUUID(), row.tenant_id, row.contact_id, crypto.randomUUID()),
        this.database.prepare(
          `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
           VALUES (?1, 'email', LOWER(?2), 'opt_out', 'one_click_unsubscribe')
           ON CONFLICT (tenant_id, channel, address_normalized) DO UPDATE SET reason = 'opt_out', source = 'one_click_unsubscribe', created_at = CURRENT_TIMESTAMP`,
        ).bind(row.tenant_id, row.email),
        this.database.prepare("UPDATE unsubscribe_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = ?1 AND used_at IS NULL").bind(token),
      ]);
    }
    return true;
  }
}

function mapContact(row: ContactRow): ContactSummary {
  return { id: row.id, email: row.email, phoneE164: row.phone_e164, displayName: row.display_name, createdAt: toIso(row.created_at) };
}

function mapCampaign(row: CampaignRow): CampaignSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel,
    status: row.status,
    ...(row.sender_identity_id ? { senderIdentityId: row.sender_identity_id } : {}),
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.body_html ? { bodyHtml: row.body_html } : {}),
    ...(row.scheduled_at ? { scheduledAt: toIso(row.scheduled_at) } : {}),
    bodyText: row.body_text,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function auditAction(decision: "approve" | "reject"): string {
  return decision === "approve" ? "campaign_approved" : "campaign_rejected";
}
