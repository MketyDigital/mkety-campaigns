import { normalizeDomain, type AzureCommunicationDomains, type AzureDomainState, type VerificationType } from "./azure-arm.js";

export type TenantEmailDomain = {
  id: string;
  tenantId: string;
  domainName: string;
  azureResourceId: string | null;
  provisioningState: string;
  verificationRecords: AzureDomainState["verificationRecords"];
  verificationStates: AzureDomainState["verificationStates"];
  linked: boolean;
  updatedAt: string;
};

export type NewTenantEmailDomain = Pick<TenantEmailDomain, "id" | "tenantId" | "domainName">;
export type TenantDomainState = Omit<TenantEmailDomain, "id" | "tenantId" | "domainName" | "updatedAt">;

export interface DomainRepository {
  list(tenantId: string): Promise<TenantEmailDomain[]>;
  get(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  insertPending(domain: NewTenantEmailDomain): Promise<TenantEmailDomain>;
  saveState(tenantId: string, id: string, state: TenantDomainState): Promise<TenantEmailDomain | null>;
}

export interface TenantDomainService {
  list(tenantId: string): Promise<TenantEmailDomain[]>;
  get(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  create(tenantId: string, domainName: string): Promise<TenantEmailDomain>;
  retryCreate(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  refresh(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  verify(tenantId: string, id: string, type: VerificationType): Promise<TenantEmailDomain | null>;
}

export class DomainConflictError extends Error {
  constructor() {
    super("This domain is already registered");
    this.name = "DomainConflictError";
  }
}

export class DomainProvisioningError extends Error {
  constructor() {
    super("Azure could not provision this email domain");
    this.name = "DomainProvisioningError";
  }
}

export class DomainRetryNotAvailableError extends Error {
  constructor() {
    super("Only a failed domain provisioning operation can be retried");
    this.name = "DomainRetryNotAvailableError";
  }
}

export function createTenantDomainService(repository: DomainRepository, provider: AzureCommunicationDomains): TenantDomainService {
  return {
    list: (tenantId) => repository.list(tenantId),
    get: (tenantId, id) => repository.get(tenantId, id),

    async create(tenantId, domainName) {
      const normalized = normalizeDomain(domainName);
      const id = crypto.randomUUID();
      let saved: TenantEmailDomain;
      try {
        saved = await repository.insertPending({ id, tenantId, domainName: normalized });
      } catch (error) {
        if (error instanceof DomainConflictError || isUniqueViolation(error)) throw new DomainConflictError();
        throw error;
      }

      try {
        const state = await provider.createDomain(normalized);
        const updated = await repository.saveState(tenantId, id, fromProviderState(state));
        if (!updated) throw new Error("Domain disappeared during provisioning");
        return updated;
      } catch {
        await repository.saveState(tenantId, id, {
          azureResourceId: saved.azureResourceId,
          provisioningState: "Failed",
          verificationRecords: {},
          verificationStates: {},
          linked: false,
        });
        throw new DomainProvisioningError();
      }
    },

    async retryCreate(tenantId, id) {
      const saved = await repository.get(tenantId, id);
      if (!saved) return null;
      if (saved.provisioningState !== "Failed") throw new DomainRetryNotAvailableError();

      try {
        const state = await provider.createDomain(saved.domainName);
        const updated = await repository.saveState(tenantId, id, fromProviderState(state));
        if (!updated) throw new Error("Domain disappeared during provisioning retry");
        return updated;
      } catch {
        await repository.saveState(tenantId, id, {
          azureResourceId: saved.azureResourceId,
          provisioningState: "Failed",
          verificationRecords: {},
          verificationStates: {},
          linked: false,
        });
        throw new DomainProvisioningError();
      }
    },

    async refresh(tenantId, id) {
      const saved = await repository.get(tenantId, id);
      if (!saved) return null;

      let state: AzureDomainState;
      try {
        state = await provider.getDomain(saved.domainName);
        if (isDnsVerified(state) && state.provisioningState === "Succeeded" && !state.linked) {
          await provider.linkVerifiedDomain(saved.domainName);
          state = { ...state, linked: true };
        }
      } catch {
        throw new DomainProvisioningError();
      }
      return repository.saveState(tenantId, id, fromProviderState(state));
    },

    async verify(tenantId, id, type) {
      const saved = await repository.get(tenantId, id);
      if (!saved) return null;
      try {
        await provider.initiateVerification(saved.domainName, type);
      } catch {
        throw new DomainProvisioningError();
      }
      return this.refresh(tenantId, id);
    },
  };
}

function fromProviderState(state: AzureDomainState): TenantDomainState {
  return {
    azureResourceId: state.id,
    provisioningState: state.provisioningState,
    verificationRecords: state.verificationRecords,
    verificationStates: state.verificationStates,
    linked: state.linked,
  };
}

function isDnsVerified(state: AzureDomainState): boolean {
  const types = Object.keys(state.verificationRecords);
  return types.length > 0 && types.every((type) => state.verificationStates[type as VerificationType]?.status === "Verified");
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE";
}
