import { hashPassword } from "better-auth/crypto";
import type { PostgresPool } from "../campaigns/repository.js";

export interface OperationsService {
  createTenantInvite(tenantName: string, email: string): Promise<{ inviteUrl: string }>;
  acceptInvite(token: string, displayName: string, password: string): Promise<boolean>;
}

type InvitationRow = { id: string; tenant_id: string; email: string };

/** Ops-managed tenant and seat provisioning. Invitation tokens are stored only as hashes. */
export class PostgresOperationsService implements OperationsService {
  private readonly origin: string;

  constructor(private readonly database: PostgresPool, baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("BETTER_AUTH_URL must use HTTPS outside localhost");
    this.origin = url.origin;
  }

  async createTenantInvite(tenantName: string, email: string): Promise<{ inviteUrl: string }> {
    const name = tenantName.trim();
    const normalizedEmail = normalizeEmail(email);
    if (!name || name.length > 160) throw new Error("Tenant name must contain 1 to 160 characters");
    const token = createToken();
    const tokenHash = await hashToken(token);
    const tenantId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT id FROM users WHERE lower(email) = $1 LIMIT 1", [normalizedEmail]);
      if (existing.rows.length) throw new Error("This email already has an account");
      const pending = await client.query("SELECT id FROM tenant_invites WHERE lower(email) = $1 AND accepted_at IS NULL AND expires_at > NOW() LIMIT 1", [normalizedEmail]);
      if (pending.rows.length) throw new Error("An active invitation already exists for this email");
      await client.query("INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'approved')", [tenantId, name]);
      await client.query(
        `INSERT INTO tenant_invites (id, tenant_id, email, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
        [inviteId, tenantId, normalizedEmail, tokenHash]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { inviteUrl: `${this.origin}/invite/accept?token=${encodeURIComponent(token)}` };
  }

  async acceptInvite(token: string, displayName: string, password: string): Promise<boolean> {
    if (token.length < 32 || token.length > 128) return false;
    const name = displayName.trim();
    if (!name || name.length > 160 || password.length < 12 || password.length > 128) throw new Error("Name or password does not meet the requirements");
    const tokenHash = await hashToken(token);
    const passwordHash = await hashPassword(password);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const lookup = await client.query<InvitationRow>(
        `SELECT id, tenant_id, email FROM tenant_invites
          WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
          FOR UPDATE`, [tokenHash]);
      const invite = lookup.rows[0];
      if (!invite) { await client.query("ROLLBACK"); return false; }
      const userId = crypto.randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO users (id, email, display_name, role, email_verified, created_at, updated_at)
         VALUES ($1, $2, $3, 'tenant', FALSE, $4, $4)`, [userId, invite.email, name, now]);
      await client.query(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES ($1, $2, 'credential', $2, $3, $4, $4)`, [crypto.randomUUID(), userId, passwordHash, now]);
      await client.query(
        `INSERT INTO tenant_seats (tenant_id, user_id, status, activated_at)
         VALUES ($1, $2, 'active', $3)`, [invite.tenant_id, userId, now]);
      await client.query("UPDATE tenant_invites SET accepted_at = $2 WHERE id = $1", [invite.id, now]);
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

/** D1 implementation follows the same schema and keeps token redemption atomic in a batch. */
export class D1OperationsService implements OperationsService {
  private readonly origin: string;

  constructor(private readonly database: D1Database, baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("BETTER_AUTH_URL must use HTTPS outside localhost");
    this.origin = url.origin;
  }

  async createTenantInvite(tenantName: string, email: string): Promise<{ inviteUrl: string }> {
    const name = tenantName.trim();
    const normalizedEmail = normalizeEmail(email);
    if (!name || name.length > 160) throw new Error("Tenant name must contain 1 to 160 characters");
    const token = createToken();
    const tokenHash = await hashToken(token);
    const tenantId = crypto.randomUUID();
    const existing = await this.database.prepare("SELECT id FROM users WHERE lower(email) = ?1 LIMIT 1").bind(normalizedEmail).first<{ id: string }>();
    if (existing) throw new Error("This email already has an account");
    const pending = await this.database.prepare("SELECT id FROM tenant_invites WHERE lower(email) = ?1 AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP LIMIT 1").bind(normalizedEmail).first<{ id: string }>();
    if (pending) throw new Error("An active invitation already exists for this email");
    await this.database.batch([
      this.database.prepare("INSERT INTO tenants (id, name, status) VALUES (?1, ?2, 'approved')").bind(tenantId, name),
      this.database.prepare("INSERT INTO tenant_invites (id, tenant_id, email, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4, datetime('now', '+7 days'))").bind(crypto.randomUUID(), tenantId, normalizedEmail, tokenHash),
    ]);
    return { inviteUrl: `${this.origin}/invite/accept?token=${encodeURIComponent(token)}` };
  }

  async acceptInvite(token: string, displayName: string, password: string): Promise<boolean> {
    if (token.length < 32 || token.length > 128) return false;
    const name = displayName.trim();
    if (!name || name.length > 160 || password.length < 12 || password.length > 128) throw new Error("Name or password does not meet the requirements");
    const tokenHash = await hashToken(token);
    const passwordHash = await hashPassword(password);
    const invite = await this.database.prepare(
      "SELECT id FROM tenant_invites WHERE token_hash = ?1 AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
    ).bind(tokenHash).first<{ id: string }>();
    if (!invite) return false;
    const userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare("UPDATE tenant_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = ?2 WHERE id = ?1 AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP").bind(invite.id, userId),
      this.database.prepare(
        `INSERT INTO users (id, email, display_name, role, email_verified, created_at, updated_at)
         SELECT ?2, email, ?3, 'tenant', FALSE, ?4, ?4 FROM tenant_invites WHERE id = ?1 AND accepted_user_id = ?2
         ON CONFLICT(email) DO NOTHING`,
      ).bind(invite.id, userId, name, now),
      this.database.prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
         SELECT ?1, ?2, 'credential', ?2, ?3, ?4, ?4 FROM users WHERE id = ?2
         ON CONFLICT(provider_id, account_id) DO NOTHING`,
      ).bind(accountId, userId, passwordHash, now),
      this.database.prepare(
        `INSERT INTO tenant_seats (tenant_id, user_id, status, activated_at)
         SELECT tenant_id, ?2, 'active', ?3 FROM tenant_invites WHERE id = ?1 AND accepted_user_id = ?2
         ON CONFLICT DO NOTHING`,
      ).bind(invite.id, userId, now),
    ]);
    const redeemed = await this.database.prepare(
      `SELECT s.user_id FROM tenant_invites i JOIN tenant_seats s ON s.tenant_id = i.tenant_id
        WHERE i.id = ?1 AND i.accepted_user_id = ?2 AND s.user_id = ?2`,
    ).bind(invite.id, userId).first<{ user_id: string }>();
    return Boolean(redeemed);
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw new Error("Enter a valid email address");
  return normalized;
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
