import type { PostgresPool } from "../campaigns/repository.js";
import { validateEmailDeliveryEvent, type EmailDeliveryEvent } from "./delivery-events.js";

export type ReconciliationResult = "recorded" | "duplicate" | "unmatched";

/**
 * Call only after provider-specific webhook authentication and mapping.
 * This deliberately has no HTTP route: untrusted callers must never be able
 * to manufacture a bounce or complaint for another tenant.
 */
export class PostgresEmailEventReconciler {
  constructor(private readonly db: PostgresPool) {}

  async reconcile(raw: unknown): Promise<ReconciliationResult> {
    const event = validateEmailDeliveryEvent(raw);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const match = await client.query<{ id: string; tenant_id: string; email: string | null }>(
        `SELECT da.id, da.tenant_id, ct.email
           FROM delivery_attempts da
           JOIN contacts ct ON ct.id = da.contact_id AND ct.tenant_id = da.tenant_id
          WHERE da.provider = $1 AND da.provider_message_id = $2 AND da.channel = 'email'
          ORDER BY da.id LIMIT 2 FOR UPDATE OF da`,
        [event.provider, event.providerMessageId],
      );
      if (match.rows.length === 0) {
        await client.query("ROLLBACK");
        return "unmatched";
      }
      if (match.rows.length !== 1) throw new Error("Ambiguous provider delivery message ID");
      const attempt = match.rows[0]!;
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO email_delivery_events (provider, event_id, delivery_attempt_id, outcome, occurred_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (provider, event_id) DO NOTHING RETURNING event_id`,
        [event.provider, event.eventId, attempt.id, event.outcome, event.occurredAt],
      );
      if (!inserted.rows.length) {
        await client.query("ROLLBACK");
        return "duplicate";
      }
      await client.query(
        `UPDATE delivery_attempts
            SET status = CASE
              WHEN status IN ('bounced', 'complained') THEN status
              WHEN last_event_at IS NULL OR last_event_at <= $2::timestamptz THEN $3 ELSE status END,
                last_event_at = CASE
              WHEN last_event_at IS NULL OR last_event_at < $2::timestamptz THEN $2::timestamptz
              ELSE last_event_at END
          WHERE id = $1`,
        [attempt.id, event.occurredAt, event.outcome],
      );
      if (shouldSuppress(event) && attempt.email) {
        await client.query(
          `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
           VALUES ($1, 'email', LOWER($2), $3, $4)
           ON CONFLICT (tenant_id, channel, address_normalized) DO NOTHING`,
          [attempt.tenant_id, attempt.email, event.outcome, event.provider],
        );
      }
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class D1EmailEventReconciler {
  constructor(private readonly db: D1Database) {}

  async reconcile(raw: unknown): Promise<ReconciliationResult> {
    const event = validateEmailDeliveryEvent(raw);
    const matching = await this.db.prepare(
      `SELECT da.id, da.tenant_id, ct.email
         FROM delivery_attempts da
         JOIN contacts ct ON ct.id = da.contact_id AND ct.tenant_id = da.tenant_id
        WHERE da.provider = ?1 AND da.provider_message_id = ?2 AND da.channel = 'email'
        ORDER BY da.id LIMIT 2`,
    ).bind(event.provider, event.providerMessageId).all<{ id: string; tenant_id: string; email: string | null }>();
    const rows = matching.results ?? [];
    if (!rows.length) return "unmatched";
    if (rows.length !== 1) throw new Error("Ambiguous provider delivery message ID");
    const attempt = rows[0]!;
    const existing = await this.db.prepare(
      "SELECT delivery_attempt_id FROM email_delivery_events WHERE provider = ?1 AND event_id = ?2",
    ).bind(event.provider, event.eventId).first<{ delivery_attempt_id: string }>();
    if (existing) return "duplicate";
    // D1 batch is transactional. ON CONFLICT prevents duplicate event storage,
    // and both mutations depend on the saved event to avoid a replay changing
    // state. Suppression is monotonic: events cannot remove existing blocks.
    const insert = this.db.prepare(
      `INSERT INTO email_delivery_events (provider, event_id, delivery_attempt_id, outcome, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(provider, event_id) DO NOTHING`,
    ).bind(event.provider, event.eventId, attempt.id, event.outcome, event.occurredAt);
    const update = this.db.prepare(
      `UPDATE delivery_attempts SET
        status = CASE WHEN status IN ('bounced','complained') THEN status
          WHEN last_event_at IS NULL OR datetime(last_event_at) <= datetime(?3) THEN ?4 ELSE status END,
        last_event_at = CASE WHEN last_event_at IS NULL OR datetime(last_event_at) < datetime(?3)
          THEN ?3 ELSE last_event_at END
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM email_delivery_events
         WHERE provider = ?5 AND event_id = ?2 AND delivery_attempt_id = ?1)`,
    ).bind(attempt.id, event.eventId, event.occurredAt, event.outcome, event.provider);
    const statements = [insert, update];
    if (shouldSuppress(event) && attempt.email) {
      statements.push(this.db.prepare(
        `INSERT INTO suppressions (tenant_id, channel, address_normalized, reason, source)
         SELECT ?1, 'email', LOWER(?2), ?3, ?4
          WHERE EXISTS (SELECT 1 FROM email_delivery_events
            WHERE provider = ?4 AND event_id = ?5 AND delivery_attempt_id = ?6)
         ON CONFLICT(tenant_id, channel, address_normalized) DO NOTHING`,
      ).bind(attempt.tenant_id, attempt.email, event.outcome, event.provider, event.eventId, attempt.id));
    }
    const outcome = await this.db.batch(statements);
    return outcome[0]?.meta.changes ? "recorded" : "duplicate";
  }
}

function shouldSuppress(event: EmailDeliveryEvent): boolean {
  return event.outcome === "bounced" || event.outcome === "complained";
}
