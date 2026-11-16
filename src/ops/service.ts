import { hashPassword } from "better-auth/crypto";
import type { PostgresPool } from "../campaigns/repository.js";

export type WorkspaceProvisioning = { plan?: "standard" | "growth" | "enterprise"; contractReference?: string; contractStartedAt?: string; expiresAt?: string | null; maxCampaignRecipients?: number; maxDailyEmailRecipients?: number };
export type WorkspaceControls = { status: "approved" | "suspended"; plan: "standard" | "growth" | "enterprise"; contractReference: string | null; contractStartedAt: string; expiresAt: string | null; maxCampaignRecipients: number; maxDailyEmailRecipients: number };
export type OpsWorkspace = WorkspaceControls & { id: string; name: string; ownerEmail: string | null; createdAt: string; pendingInviteCount: number };
export type OpsWorkspaceOverview = {
  workspaceId: string;
  days: 7 | 30 | 90;
  contacts: { total: number; emailConsented: number; smsConsented: number; emailSuppressed: number; smsSuppressed: number };
  campaignsByStatus: Array<{ status: string; count: number }>;
  deliveryByChannelStatus: Array<{ channel: string; status: string; count: number }>;
  domainReadiness: { total: number; ready: number; pending: number };
  senderReadiness: { total: number; ready: number; pending: number };
};
export type OpsDomainFailure = {
  id: string;
  tenantId: string;
  workspaceName: string;
  domainName: string;
  provider: "acs-email" | "oci-email-delivery";
  provisioningState: string;
  providerErrorStatus: number | null;
  providerErrorCode: string | null;
  providerRequestId: string | null;
  providerErrorAt: string | null;
};

export interface OperationsService {
  createTenantInvite(tenantName: string, email: string, settings?: WorkspaceProvisioning, actorId?: string): Promise<{ inviteUrl: string }>;
  acceptInvite(token: string, displayName: string, password: string): Promise<boolean>;
  listWorkspaces?(): Promise<OpsWorkspace[]>;
  getWorkspaceOverview?(id: string, days: number): Promise<OpsWorkspaceOverview | null>;
  updateWorkspace?(id: string, settings: Partial<WorkspaceControls>, actorId: string): Promise<OpsWorkspace | null>;
  listInvitations?(): Promise<Array<{ id: string; tenantId: string; tenantName: string; email: string; status: string; expiresAt: string; acceptedAt: string | null }>>;
  rotateInvitation?(id: string, actorId: string): Promise<{ inviteUrl: string } | null>;
  revokeInvitation?(id: string, actorId: string): Promise<boolean>;
  listDomainFailures?(): Promise<OpsDomainFailure[]>;
  recordDomainProviderRetry?(id: string, fromProvider: string, toProvider: string, outcome: string, actorId: string): Promise<void>;
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

  async createTenantInvite(tenantName: string, email: string, settings: WorkspaceProvisioning = {}, actorId?: string): Promise<{ inviteUrl: string }> {
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
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [normalizedEmail]);
      await client.query("UPDATE tenant_invites SET revoked_at=NOW() WHERE lower(email)=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=NOW()", [normalizedEmail]);
      const existing = await client.query("SELECT id FROM users WHERE lower(email) = $1 LIMIT 1", [normalizedEmail]);
      if (existing.rows.length) throw new Error("This email already has an account");
      const pending = await client.query("SELECT id FROM tenant_invites WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1", [normalizedEmail]);
      if (pending.rows.length) throw new Error("An active invitation already exists for this email");
      const limits = validateProvisioning(settings);
      await client.query(
        "INSERT INTO tenants (id,name,status,plan,contract_reference,contract_started_at,expires_at,max_campaign_recipients,max_daily_email_recipients) VALUES ($1,$2,'approved',$3,$4,$5,$6,$7,$8)",
        [tenantId, name, limits.plan, limits.contractReference, limits.contractStartedAt, limits.expiresAt, limits.maxCampaignRecipients, limits.maxDailyEmailRecipients]);
      await client.query(
        "INSERT INTO campaign_ops_audit (actor_user_id,action,details_json) VALUES ($1,'workspace_created',$2)",
        [actorId ?? null, JSON.stringify({ tenantId, name, ownerEmail: normalizedEmail, ...limits })]);
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

  async getWorkspaceOverview(id: string, days: number): Promise<OpsWorkspaceOverview | null> {
    if (!id || id.length > 128) throw new Error("Invalid workspace id");
    if (days !== 7 && days !== 30 && days !== 90) throw new Error("Invalid reporting window");
    const result = await this.database.query<any>(
      `SELECT t.id AS workspace_id,
              (SELECT COUNT(*)::int FROM contacts c WHERE c.tenant_id=t.id) AS contact_count,
              (SELECT COUNT(*)::int FROM (
                 SELECT DISTINCT ON (cr.contact_id) cr.contact_id,cr.state
                 FROM consent_records cr WHERE cr.tenant_id=t.id AND cr.channel='email'
                 ORDER BY cr.contact_id,cr.occurred_at DESC,cr.id DESC
               ) latest WHERE latest.state='granted') AS email_consented,
              (SELECT COUNT(*)::int FROM (
                 SELECT DISTINCT ON (cr.contact_id) cr.contact_id,cr.state
                 FROM consent_records cr WHERE cr.tenant_id=t.id AND cr.channel='sms'
                 ORDER BY cr.contact_id,cr.occurred_at DESC,cr.id DESC
               ) latest WHERE latest.state='granted') AS sms_consented,
              (SELECT COUNT(*)::int FROM suppressions s WHERE s.tenant_id=t.id AND s.channel='email') AS email_suppressed,
              (SELECT COUNT(*)::int FROM suppressions s WHERE s.tenant_id=t.id AND s.channel='sms') AS sms_suppressed,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('status',c.status,'count',c.campaign_count) ORDER BY c.status)
                FROM (SELECT status,COUNT(*)::int AS campaign_count FROM campaigns WHERE tenant_id=t.id GROUP BY status) c),'[]'::jsonb) AS campaign_statuses,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('channel',d.channel,'status',d.status,'count',d.attempt_count) ORDER BY d.channel,d.status)
                FROM (SELECT channel,status,COUNT(*)::int AS attempt_count FROM delivery_attempts
                  WHERE tenant_id=t.id AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
                  GROUP BY channel,status) d),'[]'::jsonb) AS delivery_statuses
         FROM tenants t WHERE t.id=$1 LIMIT 1`,
      [id, days],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [domainResult, senderResult] = await Promise.all([
      this.database.query<any>(
        "SELECT provisioning_state,linked,verification_records_json,verification_states_json FROM tenant_email_domains WHERE tenant_id=$1",
        [id],
      ),
      this.database.query<any>(
        "SELECT status,COUNT(*)::int AS count FROM tenant_sender_identities WHERE tenant_id=$1 GROUP BY status ORDER BY status",
        [id],
      ),
    ]);
    const domains = domainResult.rows;
    const readyDomains = domains.filter(isReadyOpsDomain).length;
    const senderCounts = new Map<string, number>(senderResult.rows.map((item:any) => [item.status, Number(item.count)]));
    const readySenders = senderCounts.get("ready") ?? 0;
    const totalSenders = [...senderCounts.values()].reduce((sum,count) => sum + count, 0);
    const counts = (value: unknown) => Array.isArray(value) ? value.map((item: any) => ({ ...item, count: Number(item.count) })) : [];
    return {
      workspaceId: row.workspace_id,
      days,
      contacts: {
        total: Number(row.contact_count ?? 0),
        emailConsented: Number(row.email_consented ?? 0),
        smsConsented: Number(row.sms_consented ?? 0),
        emailSuppressed: Number(row.email_suppressed ?? 0),
        smsSuppressed: Number(row.sms_suppressed ?? 0),
      },
      campaignsByStatus: counts(row.campaign_statuses),
      deliveryByChannelStatus: counts(row.delivery_statuses),
      domainReadiness: { total: domains.length, ready: readyDomains, pending: domains.length - readyDomains },
      senderReadiness: { total: totalSenders, ready: readySenders, pending: totalSenders - readySenders },
    };
  }

  async listWorkspaces(): Promise<OpsWorkspace[]> {
    const result = await this.database.query<any>(
      `SELECT t.id,t.name,t.status,t.plan,t.contract_reference,t.contract_started_at,t.expires_at,
              t.max_campaign_recipients,t.max_daily_email_recipients,t.created_at,
              COALESCE((SELECT u.email FROM tenant_seats s JOIN users u ON u.id=s.user_id
                WHERE s.tenant_id=t.id AND s.status IN ('active','invited') ORDER BY s.created_at LIMIT 1),
                (SELECT i.email FROM tenant_invites i WHERE i.tenant_id=t.id ORDER BY i.created_at DESC LIMIT 1)) AS owner_email,
              (SELECT COUNT(*)::int FROM tenant_invites i WHERE i.tenant_id=t.id AND i.accepted_at IS NULL
                AND i.revoked_at IS NULL AND i.expires_at>NOW()) AS pending_invite_count
         FROM tenants t ORDER BY t.created_at DESC LIMIT 500`);
    return result.rows.map((row:any)=>({id:row.id,name:row.name,status:row.status,plan:row.plan,
      contractReference:row.contract_reference,contractStartedAt:new Date(row.contract_started_at).toISOString(),
      expiresAt:row.expires_at?new Date(row.expires_at).toISOString():null,
      maxCampaignRecipients:row.max_campaign_recipients,maxDailyEmailRecipients:row.max_daily_email_recipients,
      createdAt:new Date(row.created_at).toISOString(),ownerEmail:row.owner_email??null,pendingInviteCount:row.pending_invite_count}));
  }

  async listDomainFailures(): Promise<OpsDomainFailure[]> {
    const result = await this.database.query<any>(
      `SELECT d.id,d.tenant_id,t.name AS workspace_name,d.domain_name,d.provider,d.provisioning_state,
              d.provider_error_status,d.provider_error_code,d.provider_request_id,d.provider_error_at
         FROM tenant_email_domains d JOIN tenants t ON t.id=d.tenant_id
        WHERE d.provisioning_state IN ('Failed','Unknown')
        ORDER BY d.updated_at DESC LIMIT 200`,
    );
    return result.rows.map((row: any) => ({
      id: row.id, tenantId: row.tenant_id, workspaceName: row.workspace_name, domainName: row.domain_name,
      provider: row.provider, provisioningState: row.provisioning_state,
      providerErrorStatus: row.provider_error_status === null ? null : Number(row.provider_error_status),
      providerErrorCode: row.provider_error_code ?? null, providerRequestId: row.provider_request_id ?? null,
      providerErrorAt: row.provider_error_at ? new Date(row.provider_error_at).toISOString() : null,
    }));
  }

  async recordDomainProviderRetry(id: string, fromProvider: string, toProvider: string, outcome: string, actorId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid domain reference");
    const allowedProviders = new Set(["acs-email", "oci-email-delivery"]);
    if (!allowedProviders.has(fromProvider) || !allowedProviders.has(toProvider)) throw new Error("Invalid provider");
    const safeOutcome = ["started", "confirmed-existing", "fallback-started", "fallback-succeeded", "fallback-failed", "blocked"].includes(outcome) ? outcome : "blocked";
    await this.database.query(
      "INSERT INTO campaign_ops_audit (actor_user_id,action,details_json) VALUES ($1,'email_domain_provider_retry',$2)",
      [actorId, JSON.stringify({ domainId: id, fromProvider, toProvider, outcome: safeOutcome })],
    );
  }

  async updateWorkspace(id: string, settings: Partial<WorkspaceControls>, actorId: string): Promise<OpsWorkspace | null> {
    if (!id || id.length > 128) throw new Error("Invalid workspace id");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<any>(
        "SELECT id,name,status,plan,contract_reference,contract_started_at,expires_at,max_campaign_recipients,max_daily_email_recipients FROM tenants WHERE id=$1 FOR UPDATE",
        [id],
      );
      const current = currentResult.rows[0];
      if (!current) { await client.query("ROLLBACK"); return null; }
      const merged = validateProvisioning({
        plan: settings.plan ?? current.plan,
        contractReference: settings.contractReference === undefined ? current.contract_reference : settings.contractReference,
        contractStartedAt: settings.contractStartedAt ?? new Date(current.contract_started_at).toISOString(),
        expiresAt: settings.expiresAt === undefined ? (current.expires_at ? new Date(current.expires_at).toISOString() : null) : settings.expiresAt,
        maxCampaignRecipients: settings.maxCampaignRecipients ?? current.max_campaign_recipients,
        maxDailyEmailRecipients: settings.maxDailyEmailRecipients ?? current.max_daily_email_recipients,
      });
      const status = settings.status ?? current.status;
      if (status !== "approved" && status !== "suspended") throw new Error("Invalid workspace status");
      await client.query(
        "UPDATE tenants SET status=$2,plan=$3,contract_reference=$4,contract_started_at=$5,expires_at=$6,max_campaign_recipients=$7,max_daily_email_recipients=$8,updated_at=NOW() WHERE id=$1",
        [id,status,merged.plan,merged.contractReference,merged.contractStartedAt,merged.expiresAt,merged.maxCampaignRecipients,merged.maxDailyEmailRecipients],
      );
      const contractBlocked = status === "suspended" || new Date(merged.contractStartedAt) > new Date() || Boolean(merged.expiresAt && new Date(merged.expiresAt) <= new Date());
      const limitsReduced = merged.maxCampaignRecipients < current.max_campaign_recipients || merged.maxDailyEmailRecipients < current.max_daily_email_recipients;
      if (contractBlocked || limitsReduced) {
        await client.query(
          "UPDATE campaign_jobs SET status='cancelled',locked_at=NULL,last_error='Workspace contract is inactive; operator review and explicit requeue are required.' WHERE tenant_id=$1 AND status='queued'",
          [id],
        );
        await client.query("UPDATE campaigns SET status='in_review',updated_at=NOW() WHERE tenant_id=$1 AND status='queued'", [id]);
      }
      await client.query(
        "INSERT INTO campaign_ops_audit (actor_user_id,action,details_json) VALUES ($1,'workspace_updated',$2)",
        [actorId,JSON.stringify({workspaceId:id,before:{status:current.status,plan:current.plan,expiresAt:current.expires_at},after:{status,...merged}})],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const listed = await this.listWorkspaces();
    return listed.find(row => row.id === id) ?? null;
  }

  async listInvitations() {
    const result=await this.database.query<any>(
      `SELECT i.id,i.tenant_id,t.name AS tenant_name,i.email,i.expires_at,i.accepted_at,i.revoked_at
         FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id ORDER BY i.created_at DESC LIMIT 500`);
    return result.rows.map((row:any)=>({id:row.id,tenantId:row.tenant_id,tenantName:row.tenant_name,email:row.email,
      status:row.accepted_at?"accepted":row.revoked_at?"revoked":new Date(row.expires_at)<=new Date()?"expired":"pending",
      expiresAt:new Date(row.expires_at).toISOString(),acceptedAt:row.accepted_at?new Date(row.accepted_at).toISOString():null}));
  }

  async rotateInvitation(id: string, actorId: string): Promise<{inviteUrl:string}|null> {
    const token=createToken(),tokenHash=await hashToken(token),client=await this.database.connect();
    try {
      await client.query("BEGIN");
      const result=await client.query<{tenant_id:string;email:string}>(
        `SELECT i.tenant_id,i.email FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id
          WHERE i.id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND t.status='approved' AND t.contract_started_at<=NOW() AND (t.expires_at IS NULL OR t.expires_at>NOW()) FOR UPDATE OF i`,[id]);
      const invite=result.rows[0];if(!invite){await client.query("ROLLBACK");return null;}
      await client.query("UPDATE tenant_invites SET token_hash=$2,expires_at=NOW()+INTERVAL '7 days' WHERE id=$1",[id,tokenHash]);
      await client.query("INSERT INTO campaign_ops_audit (actor_user_id,action,details_json) VALUES ($1,'invitation_rotated',$2)",[actorId,JSON.stringify({invitationId:id,tenantId:invite.tenant_id,email:invite.email})]);
      await client.query("COMMIT");
    } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
    return {inviteUrl:`${this.origin}/invite/accept?token=${encodeURIComponent(token)}`};
  }

  async revokeInvitation(id: string, actorId: string): Promise<boolean> {
    const client=await this.database.connect();
    try {
      await client.query("BEGIN");
      const result=await client.query<{tenant_id:string;email:string}>("UPDATE tenant_invites SET revoked_at=NOW() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING tenant_id,email",[id]);
      const invite=result.rows[0];if(!invite){await client.query("ROLLBACK");return false;}
      await client.query("INSERT INTO campaign_ops_audit (actor_user_id,action,details_json) VALUES ($1,'invitation_revoked',$2)",[actorId,JSON.stringify({invitationId:id,tenantId:invite.tenant_id,email:invite.email})]);
      await client.query("COMMIT");return true;
    } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
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
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
            AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = tenant_invites.tenant_id AND t.status = 'approved' AND t.contract_started_at <= NOW() AND (t.expires_at IS NULL OR t.expires_at > NOW()))
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


function isReadyOpsDomain(row: { provisioning_state?: unknown; linked?: unknown; verification_records_json?: unknown; verification_states_json?: unknown }): boolean {
  if (row.linked !== true || row.provisioning_state !== "Succeeded") return false;
  try {
    const records = typeof row.verification_records_json === "string" ? JSON.parse(row.verification_records_json) : row.verification_records_json;
    const states = typeof row.verification_states_json === "string" ? JSON.parse(row.verification_states_json) : row.verification_states_json;
    if (!records || typeof records !== "object" || !states || typeof states !== "object") return false;
    const types = Object.keys(records as Record<string, unknown>);
    return types.length > 0 && types.every((type) => (states as Record<string, { status?: unknown }>)[type]?.status === "Verified");
  } catch {
    return false;
  }
}

function validateProvisioning(settings: WorkspaceProvisioning): Required<Pick<WorkspaceControls,"plan"|"contractReference"|"contractStartedAt"|"expiresAt"|"maxCampaignRecipients"|"maxDailyEmailRecipients">> {
  const plan=settings.plan??"standard";
  if(!["standard","growth","enterprise"].includes(plan))throw new Error("Invalid workspace plan");
  const contractReference=(settings.contractReference??"").trim();
  if(contractReference.length>120)throw new Error("Contract reference is too long");
  const started=settings.contractStartedAt?new Date(settings.contractStartedAt):new Date();
  const expires=settings.expiresAt?new Date(settings.expiresAt):null;
  if(Number.isNaN(started.getTime())||(settings.expiresAt&&!expires)|| (expires&&expires<=started))throw new Error("Invalid contract dates");
  const maxCampaignRecipients=settings.maxCampaignRecipients??100,maxDailyEmailRecipients=settings.maxDailyEmailRecipients??1000;
  if(!Number.isInteger(maxCampaignRecipients)||maxCampaignRecipients<1||maxCampaignRecipients>1000)throw new Error("Campaign limit must be 1 to 1000");
  if(!Number.isInteger(maxDailyEmailRecipients)||maxDailyEmailRecipients<1||maxDailyEmailRecipients>100000)throw new Error("Daily email limit must be 1 to 100000");
  return {plan,contractReference:contractReference||"",contractStartedAt:started.toISOString(),expiresAt:expires?.toISOString()??null,maxCampaignRecipients,maxDailyEmailRecipients};
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
