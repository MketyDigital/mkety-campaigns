export type DnsRecord = {
  type?: string;
  name?: string;
  value?: string;
  ttl?: number;
};

export type VerificationType = "Domain" | "SPF" | "DKIM" | "DKIM2" | "DMARC";

export type AzureDomainState = {
  id: string;
  name: string;
  provisioningState: string;
  fromSenderDomain?: string;
  mailFromSenderDomain?: string;
  verificationRecords: Partial<Record<VerificationType, DnsRecord>>;
  verificationStates: Partial<Record<VerificationType, { status: string; errorCode?: string }>>;
  linked: boolean;
};

export type AzureCommunicationDomainsConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  emailService: string;
  communicationService: string;
  fetcher?: typeof fetch;
  apiVersion?: string;
};

export interface AzureCommunicationDomains {
  createDomain(domainName: string): Promise<AzureDomainState>;
  getDomain(domainName: string): Promise<AzureDomainState>;
  initiateVerification(domainName: string, verificationType: VerificationType): Promise<void>;
  linkVerifiedDomain(domainName: string): Promise<void>;
}

const DEFAULT_API_VERSION = "2025-05-01";
const ARM_ENDPOINT = "https://management.azure.com";
const LINK_UPDATE_ATTEMPTS = 5;

class AzureArmRequestError extends Error {
  constructor(readonly status: number) {
    super(`Azure Resource Manager request failed with HTTP ${status}`);
    this.name = "AzureArmRequestError";
  }
}

export function createAzureCommunicationDomains(config: AzureCommunicationDomainsConfig): AzureCommunicationDomains {
  const tenantId = required(config.tenantId, "AZURE_ARM_TENANT_ID");
  const clientId = required(config.clientId, "AZURE_ARM_CLIENT_ID");
  const clientSecret = required(config.clientSecret, "AZURE_ARM_CLIENT_SECRET");
  const subscriptionId = required(config.subscriptionId, "AZURE_SUBSCRIPTION_ID");
  const resourceGroup = required(config.resourceGroup, "AZURE_RESOURCE_GROUP");
  const emailService = required(config.emailService, "AZURE_EMAIL_SERVICE_NAME");
  const communicationService = required(config.communicationService, "AZURE_COMMUNICATION_SERVICE_NAME");
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  const fetcher = config.fetcher ?? fetch;

  const domainResourcePath = (domainName: string) =>
    `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Communication/emailServices/${encodeURIComponent(emailService)}` +
    `/domains/${encodeURIComponent(normalizeDomain(domainName))}`;

  const communicationResourcePath = () =>
    `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Communication/communicationServices/${encodeURIComponent(communicationService)}`;

  async function getAccessToken(): Promise<string> {
    const response = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://management.azure.com/.default",
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw requestError("Azure identity token", response.status);
    const token = stringField(payload, "access_token");
    if (!token) throw new Error("Azure identity response did not include an access token");
    return token;
  }

  async function requestJson(path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const url = new URL(path, ARM_ENDPOINT);
    url.searchParams.set("api-version", apiVersion);
    const response = await fetcher(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const payload = await readJson(response);
    if (!response.ok) throw requestError("Azure Resource Manager", response.status);
    if (!stringField(payload, "etag")) {
      const etag = response.headers.get("etag");
      if (etag) payload.etag = etag;
    }
    return payload;
  }

  async function getDomainWithToken(domainName: string, token: string): Promise<AzureDomainState> {
    const payload = await requestJson(domainResourcePath(domainName), token);
    const name = stringField(payload, "name") ?? normalizeDomain(domainName);
    const id = stringField(payload, "id") ?? `${ARM_ENDPOINT}${domainResourcePath(name)}`;
    const properties = objectField(payload, "properties");
    if (!properties) throw new Error("Azure domain response did not include properties");
    return {
      id,
      name,
      provisioningState: stringField(properties, "provisioningState") ?? "Unknown",
      fromSenderDomain: stringField(properties, "fromSenderDomain"),
      mailFromSenderDomain: stringField(properties, "mailFromSenderDomain"),
      verificationRecords: recordSet(properties, "verificationRecords"),
      verificationStates: stateSet(properties, "verificationStates"),
      linked: false,
    };
  }

  return {
    async createDomain(domainName) {
      const normalized = normalizeDomain(domainName);
      const token = await getAccessToken();
      const payload = await requestJson(domainResourcePath(normalized), token, {
        method: "PUT",
        body: JSON.stringify({
          location: "Global",
          properties: {
            domainManagement: "CustomerManaged",
            userEngagementTracking: "Disabled",
          },
        }),
      });
      const properties = objectField(payload, "properties");
      if (!properties) throw new Error("Azure domain creation response did not include properties");
      const name = stringField(payload, "name") ?? normalized;
      return {
        id: stringField(payload, "id") ?? `${ARM_ENDPOINT}${domainResourcePath(name)}`,
        name,
        provisioningState: stringField(properties, "provisioningState") ?? "Accepted",
        fromSenderDomain: stringField(properties, "fromSenderDomain"),
        mailFromSenderDomain: stringField(properties, "mailFromSenderDomain"),
        verificationRecords: recordSet(properties, "verificationRecords"),
        verificationStates: stateSet(properties, "verificationStates"),
        linked: false,
      };
    },

    async getDomain(domainName) {
      const token = await getAccessToken();
      const domain = await getDomainWithToken(domainName, token);
      const communication = await requestJson(communicationResourcePath(), token);
      const properties = objectField(communication, "properties");
      const linkedDomains = arrayField(properties, "linkedDomains");
      return { ...domain, linked: linkedDomains.includes(domain.id) };
    },

    async initiateVerification(domainName, verificationType) {
      const allowedTypes: VerificationType[] = ["Domain", "SPF", "DKIM", "DKIM2", "DMARC"];
      if (!allowedTypes.includes(verificationType)) throw new Error("Unsupported Azure DNS verification type");
      const token = await getAccessToken();
      await requestJson(`${domainResourcePath(domainName)}/initiateVerification`, token, {
        method: "POST",
        body: JSON.stringify({ verificationType }),
      });
    },

    async linkVerifiedDomain(domainName) {
      const token = await getAccessToken();
      const domain = await getDomainWithToken(domainName, token);
      if (domain.provisioningState !== "Succeeded") {
        throw new Error("Azure email domain provisioning is not complete");
      }
      const verificationTypes = Object.keys(domain.verificationRecords) as VerificationType[];
      if (verificationTypes.length === 0 || verificationTypes.some((type) => domain.verificationStates[type]?.status !== "Verified")) {
        throw new Error("Azure DNS verification is incomplete");
      }

      for (let attempt = 0; attempt < LINK_UPDATE_ATTEMPTS; attempt++) {
        const communication = await requestJson(communicationResourcePath(), token);
        const properties = objectField(communication, "properties") ?? {};
        const linkedDomains = arrayField(properties, "linkedDomains");
        if (linkedDomains.includes(domain.id)) return;
        const etag = stringField(communication, "etag");
        if (!etag) throw new Error("Azure Communication Service response did not include an ETag");

        try {
          await requestJson(communicationResourcePath(), token, {
            method: "PATCH",
            headers: { "if-match": etag },
            body: JSON.stringify({ properties: { linkedDomains: [...linkedDomains, domain.id] } }),
          });
          return;
        } catch (error) {
          if (!(error instanceof AzureArmRequestError) || error.status !== 412 || attempt === LINK_UPDATE_ATTEMPTS - 1) throw error;
        }
      }
      throw new Error("Azure Communication Service changed repeatedly while linking the email domain");
    },
  };
}

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || domain.length < 4 || domain.includes("://") || domain.includes("/") || domain.includes("@")) {
    throw new Error("Enter a valid domain name");
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Enter a valid domain name");
  }
  return domain;
}

function recordSet(properties: Record<string, unknown>, key: string): AzureDomainState["verificationRecords"] {
  const records = objectField(properties, key) ?? {};
  const result: AzureDomainState["verificationRecords"] = {};
  for (const type of ["Domain", "SPF", "DKIM", "DKIM2", "DMARC"] as const) {
    const record = objectField(records, type);
    if (!record) continue;
    result[type] = {
      type: stringField(record, "type"),
      name: stringField(record, "name"),
      value: stringField(record, "value"),
      ttl: numberField(record, "ttl"),
    };
  }
  return result;
}

function stateSet(properties: Record<string, unknown>, key: string): AzureDomainState["verificationStates"] {
  const states = objectField(properties, key) ?? {};
  const result: AzureDomainState["verificationStates"] = {};
  for (const type of ["Domain", "SPF", "DKIM", "DKIM2", "DMARC"] as const) {
    const state = objectField(states, type);
    if (!state) continue;
    result[type] = { status: stringField(state, "status") ?? "Unknown", errorCode: stringField(state, "errorCode") };
  }
  return result;
}

function objectField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return typeof field === "object" && field !== null && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function arrayField(value: Record<string, unknown> | undefined, key: string): string[] {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] as number : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requestError(service: string, status: number): Error {
  if (service === "Azure Resource Manager") return new AzureArmRequestError(status);
  return new Error(`${service} request failed with HTTP ${status}`);
}
