import { DomainConflictError, type DomainRepository, type NewTenantEmailDomain, type TenantDomainState, type TenantEmailDomain } from "./service.js";

type PostgresQueryResult<T> = { rows: T[] };

export interface PostgresQueryable {
  query<T = Record<string, unknown>>(query: string, parameters?: unknown[]): Promise<PostgresQueryResult<T>>;
}

type DomainRow = {
  id: string;
  tenant_id: string;
  domain_name: string;
  azure_resource_id: string | null;
  provisioning_state: string;
  verification_records_json: string;
  verification_states_json: string;
  linked: boolean | number;
  updated_at: Date | string;
};

export class PostgresDomainRepository implements DomainRepository {
  constructor(private readonly database: PostgresQueryable) {}

  async list(tenantId: string): Promise<TenantEmailDomain[]> {
    const result = await this.database.query<DomainRow>(
      `SELECT id, tenant_id, domain_name, azure_resource_id, provisioning_state,
              verification_records_json, verification_states_json, linked, updated_at
         FROM tenant_email_domains WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async get(tenantId: string, id: string): Promise<TenantEmailDomain | null> {
    const result = await this.database.query<DomainRow>(
      `SELECT id, tenant_id, domain_name, azure_resource_id, provisioning_state,
              verification_records_json, verification_states_json, linked, updated_at
         FROM tenant_email_domains WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async insertPending(domain: NewTenantEmailDomain): Promise<TenantEmailDomain> {
    try {
      const result = await this.database.query<DomainRow>(
        `INSERT INTO tenant_email_domains (id, tenant_id, domain_name)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, domain_name, azure_resource_id, provisioning_state,
                   verification_records_json, verification_states_json, linked, updated_at`,
        [domain.id, domain.tenantId, domain.domainName],
      );
      if (!result.rows[0]) throw new Error("Domain insert did not return a row");
      return mapRow(result.rows[0]);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new DomainConflictError();
      throw error;
    }
  }

  async saveState(tenantId: string, id: string, state: TenantDomainState): Promise<TenantEmailDomain | null> {
    const result = await this.database.query<DomainRow>(
      `UPDATE tenant_email_domains
          SET azure_resource_id = $3,
              provisioning_state = $4,
              verification_records_json = $5,
              verification_states_json = $6,
              linked = $7,
              updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, tenant_id, domain_name, azure_resource_id, provisioning_state,
                  verification_records_json, verification_states_json, linked, updated_at`,
      [tenantId, id, state.azureResourceId, state.provisioningState, JSON.stringify(state.verificationRecords), JSON.stringify(state.verificationStates), state.linked],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export class D1DomainRepository implements DomainRepository {
  constructor(private readonly database: D1Database) {}

  async list(tenantId: string): Promise<TenantEmailDomain[]> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, domain_name, azure_resource_id, provisioning_state,
              verification_records_json, verification_states_json, linked, updated_at
         FROM tenant_email_domains WHERE tenant_id = ?1 ORDER BY created_at DESC`,
    ).bind(tenantId).all<DomainRow>();
    return (result.results ?? []).map(mapRow);
  }

  async get(tenantId: string, id: string): Promise<TenantEmailDomain | null> {
    const result = await this.database.prepare(
      `SELECT id, tenant_id, domain_name, azure_resource_id, provisioning_state,
              verification_records_json, verification_states_json, linked, updated_at
         FROM tenant_email_domains WHERE tenant_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(tenantId, id).first<DomainRow>();
    return result ? mapRow(result) : null;
  }

  async insertPending(domain: NewTenantEmailDomain): Promise<TenantEmailDomain> {
    try {
      await this.database.prepare(
        `INSERT INTO tenant_email_domains (id, tenant_id, domain_name) VALUES (?1, ?2, ?3)`,
      ).bind(domain.id, domain.tenantId, domain.domainName).run();
    } catch (error) {
      if (isD1UniqueViolation(error)) throw new DomainConflictError();
      throw error;
    }
    const saved = await this.get(domain.tenantId, domain.id);
    if (!saved) throw new Error("Domain insert did not return a row");
    return saved;
  }

  async saveState(tenantId: string, id: string, state: TenantDomainState): Promise<TenantEmailDomain | null> {
    await this.database.prepare(
      `UPDATE tenant_email_domains
          SET azure_resource_id = ?3,
              provisioning_state = ?4,
              verification_records_json = ?5,
              verification_states_json = ?6,
              linked = ?7,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, id, state.azureResourceId, state.provisioningState, JSON.stringify(state.verificationRecords), JSON.stringify(state.verificationStates), state.linked ? 1 : 0).run();
    return this.get(tenantId, id);
  }
}

function mapRow(row: DomainRow): TenantEmailDomain {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    domainName: row.domain_name,
    azureResourceId: row.azure_resource_id,
    provisioningState: row.provisioning_state,
    verificationRecords: parseJson(row.verification_records_json),
    verificationStates: parseJson(row.verification_states_json),
    linked: row.linked === true || row.linked === 1,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return {} as T;
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isD1UniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}
