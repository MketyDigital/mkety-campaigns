import { normalizeDomain, type AzureCommunicationDomains } from "./azure-arm.js";
import type { DomainRepository } from "./service.js";

export type SenderIdentity = {
  id: string;
  tenantId: string;
  domainId: string;
  senderAddress: string;
  displayName: string;
  provider: "acs-email";
  status: "ready" | "pending";
  createdAt: string;
};

export interface SenderRepository {
  list(tenantId: string): Promise<SenderIdentity[]>;
  get(tenantId: string, id: string): Promise<SenderIdentity | null>;
  insert(sender: SenderIdentity): Promise<SenderIdentity>;
  updateStatus(tenantId: string, id: string, status: SenderIdentity["status"]): Promise<SenderIdentity | null>;
}

export interface TenantSenderService {
  list(tenantId: string): Promise<SenderIdentity[]>;
  get(tenantId: string, id: string): Promise<SenderIdentity | null>;
  create(tenantId: string, domainId: string, username: string, displayName: string): Promise<SenderIdentity>;
  refresh(tenantId: string, id: string): Promise<SenderIdentity | null>;
}

export class SenderDomainNotReadyError extends Error {
  constructor() { super("Sender domain is not ready for email"); this.name = "SenderDomainNotReadyError"; }
}

export class SenderProvisioningError extends Error {
  constructor() { super("Azure could not provision this sender address"); this.name = "SenderProvisioningError"; }
}

export class SenderInputError extends Error {
  constructor(message: string) { super(message); this.name = "SenderInputError"; }
}

export function createTenantSenderService(
  domains: DomainRepository,
  repository: SenderRepository,
  provider: AzureCommunicationDomains,
): TenantSenderService {
  return {
    list: (tenantId) => repository.list(tenantId),
    get: (tenantId, id) => repository.get(tenantId, id),
    async refresh(tenantId, id) {
      const sender = await repository.get(tenantId, id);
      if (!sender) return null;
      if (sender.status === "ready") return sender;
      const domain = await domains.get(tenantId, sender.domainId);
      if (!domain || !isReady(domain)) throw new SenderDomainNotReadyError();
      const username = sender.senderAddress.slice(0, sender.senderAddress.lastIndexOf("@"));
      let remote;
      try {
        remote = await provider.getSenderUsername(normalizeDomain(domain.domainName), username);
      } catch {
        throw new SenderProvisioningError();
      }
      const status = remote.provisioningState === "Succeeded" ? "ready" : "pending";
      return repository.updateStatus(tenantId, id, status);
    },
    async create(tenantId, domainId, username, displayName) {
      const domain = await domains.get(tenantId, domainId);
      if (!domain || !isReady(domain)) throw new SenderDomainNotReadyError();
      const localPart = username.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(localPart)) {
        throw new SenderInputError("Enter a valid sender username");
      }
      const name = displayName.trim();
      if (!name || name.length > 100) throw new SenderInputError("Enter a display name between 1 and 100 characters");
      let remote;
      try {
        remote = await provider.createSenderUsername(normalizeDomain(domain.domainName), localPart, name);
      } catch {
        throw new SenderProvisioningError();
      }
      const state = remote.provisioningState === "Succeeded" ? "ready" : "pending";
      return repository.insert({
        id: crypto.randomUUID(), tenantId, domainId,
        senderAddress: `${localPart}@${domain.domainName}`,
        displayName: remote.displayName || name,
        provider: "acs-email", status: state,
        createdAt: new Date().toISOString(),
      });
    },
  };
}

function isReady(domain: Awaited<ReturnType<DomainRepository["get"]>>): boolean {
  if (!domain || !domain.linked || domain.provisioningState !== "Succeeded") return false;
  const recordTypes = Object.keys(domain.verificationRecords);
  return recordTypes.length > 0 && recordTypes.every((type) => domain.verificationStates[type as keyof typeof domain.verificationStates]?.status === "Verified");
}

type SenderRow = {
  id: string; tenant_id: string; domain_id: string; sender_address: string;
  display_name: string; provider: "acs-email"; status: "ready" | "pending"; created_at: Date | string;
};

export class PostgresSenderRepository implements SenderRepository {
  constructor(private readonly database: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }) {}

  async list(tenantId: string): Promise<SenderIdentity[]> {
    const result = await this.database.query<SenderRow>(
      `SELECT id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at
         FROM tenant_sender_identities WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
    return result.rows.map(mapSender);
  }

  async get(tenantId: string, id: string): Promise<SenderIdentity | null> {
    const result = await this.database.query<SenderRow>(
      `SELECT id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at
         FROM tenant_sender_identities WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [tenantId, id]);
    return result.rows[0] ? mapSender(result.rows[0]) : null;
  }

  async insert(sender: SenderIdentity): Promise<SenderIdentity> {
    const result = await this.database.query<SenderRow>(
      `INSERT INTO tenant_sender_identities (id, tenant_id, domain_id, sender_address, display_name, provider, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at`,
      [sender.id, sender.tenantId, sender.domainId, sender.senderAddress, sender.displayName, sender.provider, sender.status]);
    if (!result.rows[0]) throw new Error("Sender identity was not saved");
    return mapSender(result.rows[0]);
  }

  async updateStatus(tenantId: string, id: string, status: SenderIdentity["status"]): Promise<SenderIdentity | null> {
    const result = await this.database.query<SenderRow>(
      `UPDATE tenant_sender_identities SET status = $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at`, [tenantId, id, status]);
    return result.rows[0] ? mapSender(result.rows[0]) : null;
  }
}

export class D1SenderRepository implements SenderRepository {
  constructor(private readonly database: D1Database) {}

  async list(tenantId: string): Promise<SenderIdentity[]> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at
         FROM tenant_sender_identities WHERE tenant_id = ?1 ORDER BY created_at DESC`,
    ).bind(tenantId).all<SenderRow>();
    return (result.results ?? []).map(mapSender);
  }

  async get(tenantId: string, id: string): Promise<SenderIdentity | null> {
    const row = await this.database.prepare(
      `SELECT id, tenant_id, domain_id, sender_address, display_name, provider, status, created_at
         FROM tenant_sender_identities WHERE tenant_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(tenantId, id).first<SenderRow>();
    return row ? mapSender(row) : null;
  }

  async insert(sender: SenderIdentity): Promise<SenderIdentity> {
    await this.database.prepare(
      `INSERT INTO tenant_sender_identities (id, tenant_id, domain_id, sender_address, display_name, provider, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(sender.id, sender.tenantId, sender.domainId, sender.senderAddress, sender.displayName, sender.provider, sender.status).run();
    const saved = await this.get(sender.tenantId, sender.id);
    if (!saved) throw new Error("Sender identity was not saved");
    return saved;
  }

  async updateStatus(tenantId: string, id: string, status: SenderIdentity["status"]): Promise<SenderIdentity | null> {
    const update = await this.database.prepare(
      `UPDATE tenant_sender_identities SET status = ?3 WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, id, status).run();
    if (!update.meta.changes) return null;
    return this.get(tenantId, id);
  }
}

function mapSender(row: SenderRow): SenderIdentity {
  return {
    id: row.id, tenantId: row.tenant_id, domainId: row.domain_id,
    senderAddress: row.sender_address, displayName: row.display_name,
    provider: row.provider, status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}
