import { normalizeDomain, EmailDomainProviderError, type AzureCommunicationDomains, type AzureDomainState, type VerificationType } from "./azure-arm.js";

export type TenantEmailDomain = {
  id: string;
  tenantId: string;
  domainName: string;
  provider: "acs-email" | "oci-email-delivery";
  azureResourceId: string | null;
  provisioningState: string;
  verificationRecords: AzureDomainState["verificationRecords"];
  verificationStates: AzureDomainState["verificationStates"];
  linked: boolean;
  updatedAt: string;
  providerErrorStatus: number | null;
  providerErrorCode: string | null;
  providerRequestId: string | null;
  providerErrorAt: string | null;
};

export type NewTenantEmailDomain = Pick<TenantEmailDomain, "id" | "tenantId" | "domainName" | "provider">;
export type TenantDomainState = Omit<TenantEmailDomain, "id" | "tenantId" | "domainName" | "provider" | "updatedAt">;

export interface DomainRepository {
  list(tenantId: string): Promise<TenantEmailDomain[]>;
  get(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  insertPending(domain: NewTenantEmailDomain): Promise<TenantEmailDomain>;
  saveState(tenantId: string, id: string, state: TenantDomainState): Promise<TenantEmailDomain | null>;
  getById?(id: string): Promise<TenantEmailDomain | null>;
  switchProviderIfFailed?(id: string, from: TenantEmailDomain["provider"], to: TenantEmailDomain["provider"]): Promise<TenantEmailDomain | null>;
}

export interface TenantDomainService {
  list(tenantId: string): Promise<TenantEmailDomain[]>;
  get(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  create(tenantId: string, domainName: string): Promise<TenantEmailDomain>;
  retryCreate(tenantId: string, id: string): Promise<TenantEmailDomain | null>;
  retryFailedOnProvider?(id: string, provider: TenantEmailDomain["provider"]): Promise<TenantEmailDomain | null>;
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
    super("The selected email provider could not provision this email domain");
    this.name = "DomainProvisioningError";
  }
}

export class DomainRetryNotAvailableError extends Error {
  constructor() {
    super("Only a failed domain provisioning operation can be retried");
    this.name = "DomainRetryNotAvailableError";
  }
}

export class DomainFallbackNotSafeError extends Error {
  constructor() {
    super("Provider fallback was blocked because the original domain could not be confirmed absent");
    this.name = "DomainFallbackNotSafeError";
  }
}

function logProvisioningFailure(operation: "create" | "retry", domainId: string, error: unknown): void {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "ProviderError";
  const providerStatus = typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" && Number.isInteger(error.status)
    ? error.status
    : undefined;
  const providerCode = typeof error === "object" && error !== null && "providerCode" in error && typeof error.providerCode === "string" ? error.providerCode : undefined;
  const requestId = typeof error === "object" && error !== null && "requestId" in error && typeof error.requestId === "string" ? error.requestId : undefined;
  console.warn("Email domain provisioning failed", JSON.stringify({
    operation,
    domainId,
    errorName,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(requestId === undefined ? {} : { requestId }),
  }));
}

function errorState(error: unknown): Pick<TenantDomainState, "providerErrorStatus" | "providerErrorCode" | "providerRequestId" | "providerErrorAt" | "provisioningState"> {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && Number.isInteger(error.status) ? error.status : null;
  const rawCode = typeof error === "object" && error !== null && "providerCode" in error && typeof error.providerCode === "string" ? error.providerCode : "provider_error";
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "provider_error";
  const rawRequestId = typeof error === "object" && error !== null && "requestId" in error && typeof error.requestId === "string" ? error.requestId : null;
  const requestId = rawRequestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawRequestId) ? rawRequestId : null;
  const definitelyRejected = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
  return { provisioningState: definitelyRejected ? "Failed" : "Unknown", providerErrorStatus: status, providerErrorCode: code, providerRequestId: requestId, providerErrorAt: new Date().toISOString() };
}

export function createTenantDomainService(
  repository: DomainRepository,
  provider: AzureCommunicationDomains | Partial<Record<TenantEmailDomain["provider"], AzureCommunicationDomains>>,
  providerSelector: TenantEmailDomain["provider"] | (() => Promise<TenantEmailDomain["provider"]>) = "acs-email",
): TenantDomainService {
  const providerMap: Partial<Record<TenantEmailDomain["provider"], AzureCommunicationDomains>> = "createDomain" in provider
    ? { [typeof providerSelector === "string" ? providerSelector : "acs-email"]: provider as AzureCommunicationDomains }
    : provider;
  const selectedProvider = async () => typeof providerSelector === "function"
    ? providerSelector()
    : providerSelector;
  const providerFor = (name: TenantEmailDomain["provider"]) => providerMap[name];

  return {
    list: (tenantId) => repository.list(tenantId),
    get: (tenantId, id) => repository.get(tenantId, id),

    async create(tenantId, domainName) {
      const normalized = normalizeDomain(domainName);
      const providerName = await selectedProvider();
      const activeProvider = providerFor(providerName);
      if (!activeProvider) throw new DomainProvisioningError();
      const id = crypto.randomUUID();
      let saved: TenantEmailDomain;
      try {
        saved = await repository.insertPending({ id, tenantId, domainName: normalized, provider: providerName });
      } catch (error) {
        if (error instanceof DomainConflictError || isUniqueViolation(error)) throw new DomainConflictError();
        throw error;
      }

      try {
        const state = await activeProvider.createDomain(normalized);
        const updated = await repository.saveState(tenantId, id, fromProviderState(state));
        if (!updated) throw new Error("Domain disappeared during provisioning");
        return updated;
      } catch (error) {
        logProvisioningFailure("create", id, error);
        await repository.saveState(tenantId, id, {
          azureResourceId: saved.azureResourceId,
          ...errorState(error),
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
      const activeProvider = providerFor(saved.provider);
      if (!activeProvider) throw new DomainProvisioningError();
      if (saved.provisioningState !== "Failed") throw new DomainRetryNotAvailableError();

      try {
        let state: AzureDomainState;
        try {
          state = await activeProvider.getDomain(saved.domainName);
        } catch (error) {
          if (!(error && typeof error === "object" && "status" in error && error.status === 404)) throw error;
          state = await activeProvider.createDomain(saved.domainName);
        }
        const updated = await repository.saveState(tenantId, id, fromProviderState(state));
        if (!updated) throw new Error("Domain disappeared during provisioning retry");
        return updated;
      } catch (error) {
        logProvisioningFailure("retry", id, error);
        await repository.saveState(tenantId, id, {
          azureResourceId: saved.azureResourceId,
          ...errorState(error),
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
      const activeProvider = providerFor(saved.provider);
      if (!activeProvider) throw new DomainProvisioningError();

      let state: AzureDomainState;
      try {
        state = await activeProvider.getDomain(saved.domainName);
        if (isDnsVerified(state) && state.provisioningState === "Succeeded" && !state.linked) {
          await activeProvider.linkVerifiedDomain(saved.domainName);
          state = { ...state, linked: true };
        }
      } catch (error) {
        // A 404 from a follow-up read is not proof that a previously accepted
        // provisioning request failed. Keep Unknown/Accepted records intact so
        // the owner can reconcile later without being prompted to create again.
        if ((saved.provisioningState === "Unknown" || saved.provisioningState === "Accepted") &&
            error instanceof EmailDomainProviderError && error.status === 404) return saved;
        await repository.saveState(tenantId, id, {
          ...saved,
          ...errorState(error),
        });
        throw new DomainProvisioningError();
      }
      return repository.saveState(tenantId, id, fromProviderState(state));
    },

    async verify(tenantId, id, type) {
      const saved = await repository.get(tenantId, id);
      if (!saved) return null;
      const activeProvider = providerFor(saved.provider);
      if (!activeProvider) throw new DomainProvisioningError();
      try {
        await activeProvider.initiateVerification(saved.domainName, type);
      } catch {
        throw new DomainProvisioningError();
      }
      return this.refresh(tenantId, id);
    },

    async retryFailedOnProvider(id, targetProviderName) {
      const saved = await repository.getById?.(id);
      if (!saved) return null;
      if (saved.provisioningState !== "Failed" || saved.provider === targetProviderName) throw new DomainRetryNotAvailableError();
      const sourceProvider = providerFor(saved.provider);
      const targetProvider = providerFor(targetProviderName);
      if (!sourceProvider || !targetProvider || !repository.switchProviderIfFailed) throw new DomainProvisioningError();
      try {
        const existing = await sourceProvider.getDomain(saved.domainName);
        const refreshed = await repository.saveState(saved.tenantId, saved.id, fromProviderState(existing));
        if (!refreshed) throw new DomainProvisioningError();
        return refreshed;
      } catch (error) {
        if (!(error instanceof EmailDomainProviderError && error.provider === saved.provider && error.status === 404)) {
          logProvisioningFailure("retry", id, error);
          throw new DomainFallbackNotSafeError();
        }
      }
      const switched = await repository.switchProviderIfFailed(id, saved.provider, targetProviderName);
      if (!switched) throw new DomainRetryNotAvailableError();
      try {
        const state = await targetProvider.createDomain(saved.domainName);
        const updated = await repository.saveState(saved.tenantId, saved.id, fromProviderState(state));
        if (!updated) throw new DomainProvisioningError();
        return updated;
      } catch (error) {
        logProvisioningFailure("retry", id, error);
        await repository.saveState(saved.tenantId, saved.id, {
          azureResourceId: null,
          ...errorState(error),
          verificationRecords: {},
          verificationStates: {},
          linked: false,
        });
        throw new DomainProvisioningError();
      }
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
    providerErrorStatus: null,
    providerErrorCode: null,
    providerRequestId: null,
    providerErrorAt: null,
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
