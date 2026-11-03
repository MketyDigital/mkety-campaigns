import { normalizeDomain, type AzureCommunicationDomains, type AzureDomainState, type AzureSenderUsernameState } from "./azure-arm.js";
import { importOciRsaPrivateKey } from "../email/oci-crypto.js";

export type OciEmailDomainsConfig = {
  region: string;
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: string;
  compartmentOcid: string;
  fetcher?: typeof fetch;
};

const API_VERSION = "20170907";
const SPF_VALUE = "v=spf1 include:rp.oracleemaildelivery.com ~all";

/** OCI Email Delivery control-plane adapter used to provision tenant domains and approved senders. */
export function createOciEmailDomains(config: OciEmailDomainsConfig): AzureCommunicationDomains {
  const region = required(config.region, "OCI_EMAIL_REGION");
  const tenancy = required(config.tenancyOcid, "OCI_EMAIL_TENANCY_OCID");
  const user = required(config.userOcid, "OCI_EMAIL_USER_OCID");
  const fingerprint = required(config.fingerprint, "OCI_EMAIL_FINGERPRINT");
  const privateKey = required(config.privateKey, "OCI_EMAIL_PRIVATE_KEY");
  const compartment = required(config.compartmentOcid, "OCI_EMAIL_COMPARTMENT_OCID");
  const fetcher = config.fetcher ?? fetch;
  const endpoint = `https://email.${region}.oci.oraclecloud.com`;

  async function request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(path, endpoint);
    const bodyText = body ? JSON.stringify(body) : "";
    const date = new Date().toUTCString();
    const payloadHeaders = body ? [
      `content-length: ${new TextEncoder().encode(bodyText).byteLength}`,
      "content-type: application/json",
      `x-content-sha256: ${await sha256Base64(bodyText)}`,
    ] : [];
    const signedHeaders = ["(request-target)", "date", "host", ...payloadHeaders.map((header) => header.split(":")[0])];
    const signingString = [
      `(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}`,
      `date: ${date}`,
      `host: ${url.host}`,
      ...payloadHeaders,
    ].join("\n");
    const key = await importOciRsaPrivateKey(privateKey);
    const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingString))));
    const response = await fetcher(url, {
      method,
      headers: {
        date,
        ...(body ? { "content-type": "application/json", "content-length": `${new TextEncoder().encode(bodyText).byteLength}`, "x-content-sha256": await sha256Base64(bodyText) } : {}),
        authorization: `Signature version="1",keyId="${tenancy}/${user}/${fingerprint}",algorithm="rsa-sha256",headers="${signedHeaders.join(" ")}",signature="${signature}"`,
        "opc-request-id": `mkety-campaigns-${crypto.randomUUID()}`,
        ...(method === "POST" ? { "opc-retry-token": await deterministicUuid(`${path}:${bodyText}`) } : {}),
      },
      ...(body ? { body: bodyText } : {}),
    });
    let payload: Record<string, unknown> = {};
    try { payload = await response.json() as Record<string, unknown>; } catch { /* OCI may return an empty response. */ }
    if (!response.ok) throw new Error(`OCI Email Delivery control-plane request failed with HTTP ${response.status}`);
    return payload;
  }

  async function findDomainByName(domainName: string): Promise<Record<string, unknown> | undefined> {
    const query = new URLSearchParams({ compartmentId: compartment, name: normalizeDomain(domainName), limit: "100" });
    const payload = await request("GET", `/${API_VERSION}/emailDomains?${query}`);
    const items = arrayField(payload, "items");
    return items.find((item) => stringField(item, "name")?.toLowerCase() === normalizeDomain(domainName));
  }

  async function domainByName(domainName: string): Promise<Record<string, unknown>> {
    const domain = await findDomainByName(domainName);
    if (!domain) throw new Error("OCI email domain was not found");
    return domain;
  }

  async function getDomainState(domainName: string): Promise<AzureDomainState> {
    const domain = await domainByName(domainName);
    const id = required(stringField(domain, "id"), "OCI email domain id");
    const dkimQuery = new URLSearchParams({ compartmentId: compartment, emailDomainId: id, limit: "100" });
    const dkimPayload = await request("GET", `/${API_VERSION}/dkims?${dkimQuery}`);
    const dkims = arrayField(dkimPayload, "items");
    const dkim = dkims.find((item) => stringField(item, "id") === stringField(domain, "activeDkimId")) ?? dkims[0];
    const dkimHost = stringField(dkim, "dnsSubdomainName");
    const dkimValue = stringField(dkim, "cnameRecordValue");
    const dkimActive = Boolean(stringField(domain, "activeDkimId") && stringField(dkim, "lifecycleState") === "ACTIVE");
    const spfActive = domain.isSpf === true;
    const verificationRecords: AzureDomainState["verificationRecords"] = {
      SPF: { type: "TXT", name: normalizeDomain(domainName), value: SPF_VALUE },
      DKIM: { type: "CNAME", name: dkimHost ?? `oci-dkim-not-ready.${normalizeDomain(domainName)}`, value: dkimValue ?? "" },
    };
    const verificationStates: AzureDomainState["verificationStates"] = {
      SPF: { status: spfActive ? "Verified" : "NotStarted" },
      ...(dkim ? { DKIM: { status: dkimActive ? "Verified" : "NotStarted" } } : {}),
    };
    return {
      id, name: normalizeDomain(domainName),
      provisioningState: stringField(domain, "lifecycleState") === "ACTIVE" ? "Succeeded" : "Accepted",
      verificationRecords, verificationStates, linked: spfActive && dkimActive,
    };
  }

  return {
    async createDomain(domainName) {
      const normalized = normalizeDomain(domainName);
      let domain = await findDomainByName(normalized);
      if (!domain) {
        const created = await request("POST", `/${API_VERSION}/emailDomains`, { name: normalized, compartmentId: compartment });
        domain = objectField(created, "emailDomain") ?? created;
      }
      const id = required(stringField(domain, "id"), "OCI email domain id");
      const query = new URLSearchParams({ compartmentId: compartment, emailDomainId: id, limit: "100" });
      const existingDkim = arrayField(await request("GET", `/${API_VERSION}/dkims?${query}`), "items");
      if (existingDkim.length === 0) await request("POST", `/${API_VERSION}/dkims`, { emailDomainId: id });
      return getDomainState(normalized);
    },
    getDomain: getDomainState,
    async initiateVerification() { /* OCI updates verification as DNS records become visible. */ },
    async linkVerifiedDomain() { /* OCI domains are active after SPF and DKIM verification; there is no link operation. */ },
    async createSenderUsername(domainName, username, displayName): Promise<AzureSenderUsernameState> {
      const state = await getDomainState(domainName);
      if (!state.linked) throw new Error("OCI domain SPF and DKIM must be verified before creating an approved sender");
      const emailAddress = `${username}@${normalizeDomain(domainName)}`;
      const response = await request("POST", `/${API_VERSION}/senders`, { compartmentId: compartment, emailAddress });
      const sender = objectField(response, "sender") ?? response;
      return { id: stringField(sender, "id") ?? emailAddress, username, displayName, provisioningState: "Succeeded" };
    },
    async getSenderUsername(domainName, username): Promise<AzureSenderUsernameState> {
      const emailAddress = `${username}@${normalizeDomain(domainName)}`;
      const query = new URLSearchParams({ compartmentId: compartment, emailAddress, limit: "100" });
      const response = await request("GET", `/${API_VERSION}/senders?${query}`);
      const sender = arrayField(response, "items").find((item) => stringField(item, "emailAddress")?.toLowerCase() === emailAddress.toLowerCase());
      if (!sender) throw new Error("OCI approved sender was not found");
      return { id: stringField(sender, "id") ?? emailAddress, username, displayName: username, provisioningState: "Succeeded" };
    },
  };
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}
function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]; return typeof field === "string" ? field : undefined;
}
function arrayField(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const field = value[key]; return Array.isArray(field) ? field.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`); return value.trim();
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
}
async function sha256Base64(value: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function deterministicUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
