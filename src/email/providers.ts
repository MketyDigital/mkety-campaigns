import { importOciRsaPrivateKey } from "./oci-crypto.js";

export type CampaignEmail = {
  /** Stable delivery job key used to make provider requests retry-safe where supported. */
  idempotencyKey: string;
  /** Resolved by the server from a verified tenant sender identity, never raw client input. */
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
};

export type EmailSendResult = {
  provider: "acs-email" | "oci-email-delivery";
  providerMessageId?: string;
  requestId?: string;
  acceptedAt: string;
};

export interface EmailProvider {
  readonly name: EmailSendResult["provider"];
  send(message: CampaignEmail): Promise<EmailSendResult>;
  getSendStatus?(operationId: string): Promise<{ status: string; errorCode?: string }>;
}

/** Provider response is a rejection only when the HTTP response proves it never accepted the send. */
export class EmailProviderRequestError extends Error {
  constructor(
    readonly provider: EmailSendResult["provider"],
    readonly status: number,
    readonly providerCode: string,
    readonly disposition: "rejected" | "unknown",
    readonly requestId?: string,
  ) {
    super(`${provider} request failed with HTTP ${status} (${providerCode})`);
    this.name = "EmailProviderRequestError";
  }
}

type Fetcher = typeof fetch;

export function createAcsEmailProvider(config: {
  connectionString: string;
  fetcher?: Fetcher;
}): EmailProvider {
  const parsed = parseAcsConnectionString(config.connectionString);
  const fetcher = config.fetcher ?? fetch;

  return {
    name: "acs-email",
    async send(message) {
      assertMessage(message);
      const url = new URL("/emails:send?api-version=2023-03-31", parsed.endpoint);
      const body = JSON.stringify({
        senderAddress: required(message.from, "message.from"),
        recipients: { to: message.to.map((address) => ({ address })) },
        content: {
          subject: message.subject,
          ...(message.text ? { plainText: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
        },
        ...(message.headers ? { headers: message.headers } : {}),
        userEngagementTrackingDisabled: true,
      });
      const date = new Date().toUTCString();
      const contentHash = await sha256Base64(body);
      const host = url.host;
      const requestTarget = `${url.pathname}${url.search}`;
      const stringToSign = `POST\n${requestTarget}\n${date};${host};${contentHash}`;
      const key = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(base64ToBytes(parsed.accessKey)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign))));
      const operationId = await deterministicUuid(message.idempotencyKey);
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ms-date": date,
          "x-ms-content-sha256": contentHash,
          authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
          "operation-id": operationId,
          "x-ms-client-request-id": operationId,
        },
        body,
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const providerErrorBody = objectField(payload, "error");
        throw providerError("acs-email", response.status, payload, response.headers.get("x-ms-error-code") ?? (providerErrorBody ? stringField(providerErrorBody, "code") : undefined), response.headers.get("x-ms-request-id") ?? response.headers.get("x-ms-correlation-request-id"));
      }
      return {
        provider: "acs-email",
        providerMessageId: extractAcsOperationId(stringField(payload, "id"), headerValue(response, "operation-location"), parsed.endpoint),
        requestId: operationId,
        acceptedAt: new Date().toISOString(),
      };
    },
    async getSendStatus(operationId) {
      if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Invalid Azure email operation ID");
      const url = new URL(`/emails/operations/${encodeURIComponent(operationId)}?api-version=2023-03-31`, parsed.endpoint);
      const date = new Date().toUTCString();
      const contentHash = await sha256Base64("");
      const stringToSign = `GET\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`;
      const key = await crypto.subtle.importKey("raw", toArrayBuffer(base64ToBytes(parsed.accessKey)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign))));
      const response = await fetcher(url, { method: "GET", headers: {
        "x-ms-date": date,
        "x-ms-content-sha256": contentHash,
        authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      } });
      const payload = await readJson(response);
      if (!response.ok) {
        const body = objectField(payload, "error");
        throw providerError("acs-email", response.status, payload, response.headers.get("x-ms-error-code") ?? (body ? stringField(body, "code") : undefined), response.headers.get("x-ms-request-id") ?? response.headers.get("x-ms-correlation-request-id"));
      }
      const error = objectField(payload, "error");
      return {
        status: stringField(payload, "status") ?? "Unknown",
        ...(error && stringField(error, "code") ? { errorCode: stringField(error, "code") } : {}),
      };
    },
  };
}

export function parseAcsConnectionString(connectionString: string): { endpoint: string; accessKey: string } {
  const values = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    values.set(segment.slice(0, index).trim().toLowerCase(), segment.slice(index + 1).trim());
  }
  const endpoint = required(values.get("endpoint"), "ACS_EMAIL_CONNECTION_STRING endpoint");
  const accessKey = required(values.get("accesskey"), "ACS_EMAIL_CONNECTION_STRING accesskey");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") throw new Error("ACS email endpoint must use HTTPS");
  return { endpoint: parsed.origin, accessKey };
}

export function createOciEmailProvider(config: {
  endpoint: string;
  region: string;
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: string;
  compartmentOcid: string;
  fetcher?: Fetcher;
}): EmailProvider {
  const endpoint = new URL(required(config.endpoint, "OCI_EMAIL_ENDPOINT"));
  if (endpoint.protocol !== "https:") throw new Error("OCI email endpoint must use HTTPS");
  const region = required(config.region, "OCI_EMAIL_REGION");
  const tenancyOcid = required(config.tenancyOcid, "OCI_EMAIL_TENANCY_OCID");
  const userOcid = required(config.userOcid, "OCI_EMAIL_USER_OCID");
  const fingerprint = required(config.fingerprint, "OCI_EMAIL_FINGERPRINT");
  const privateKey = required(config.privateKey, "OCI_EMAIL_PRIVATE_KEY");
  const compartmentOcid = required(config.compartmentOcid, "OCI_EMAIL_COMPARTMENT_OCID");
  const fetcher = config.fetcher ?? fetch;

  return {
    name: "oci-email-delivery",
    async send(message) {
      assertMessage(message);
      const url = new URL("/20220926/actions/submitEmail", endpoint);
      const body = JSON.stringify({
        sender: { senderAddress: { email: required(message.from, "message.from") }, compartmentId: compartmentOcid },
        recipients: { to: message.to.map((email) => ({ email })) },
        subject: message.subject,
        ...(message.text ? { bodyText: message.text } : {}),
        ...(message.html ? { bodyHtml: message.html } : {}),
      });
      const date = new Date().toUTCString();
      const contentLength = new TextEncoder().encode(body).byteLength.toString();
      const contentHash = await sha256Base64(body);
      const signingHeaders = "(request-target) date host content-length content-type x-content-sha256";
      const signingString = [
        `(request-target): post ${url.pathname}${url.search}`,
        `date: ${date}`,
        `host: ${url.host}`,
        `content-length: ${contentLength}`,
        "content-type: application/json",
        `x-content-sha256: ${contentHash}`,
      ].join("\n");
      const key = await importOciRsaPrivateKey(privateKey);
      const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingString))));
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          date,
          "content-type": "application/json",
          "content-length": contentLength,
          "x-content-sha256": contentHash,
          authorization: `Signature version="1",keyId="${tenancyOcid}/${userOcid}/${fingerprint}",algorithm="rsa-sha256",headers="${signingHeaders}",signature="${signature}"`,
          "opc-retry-token": await deterministicUuid(message.idempotencyKey),
          "opc-request-id": `mkety-campaigns-${region}-${crypto.randomUUID()}`,
        },
        body,
      });
      const payload = await readJson(response);
      if (!response.ok) throw providerError("oci-email-delivery", response.status, payload, stringField(payload, "code"), response.headers.get("opc-request-id"));
      return {
        provider: "oci-email-delivery",
        providerMessageId: stringField(payload, "messageId") ?? stringField(payload, "id"),
        requestId: headerValue(response, "opc-request-id"),
        acceptedAt: new Date().toISOString(),
      };
    },
  };
}

export function createOptionalEmailProviders(env: Record<string, unknown>): EmailProvider[] {
  const values = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) as Record<string, string>;
  const acsKeys = ["ACS_EMAIL_CONNECTION_STRING"] as const;
  const ociKeys = [
    "OCI_EMAIL_ENDPOINT",
    "OCI_EMAIL_REGION",
    "OCI_EMAIL_TENANCY_OCID",
    "OCI_EMAIL_USER_OCID",
    "OCI_EMAIL_FINGERPRINT",
    "OCI_EMAIL_PRIVATE_KEY",
    "OCI_EMAIL_COMPARTMENT_OCID",
  ] as const;
  const enabled = (name: string, keys: readonly string[]) => {
    const present = keys.filter((key) => Boolean(values[key]));
    if (present.length > 0 && present.length !== keys.length) {
      throw new Error(`${name} email provider is partially configured; missing: ${keys.filter((key) => !values[key]).join(", ")}`);
    }
    return present.length === keys.length;
  };

  const providers: EmailProvider[] = [];
  if (enabled("ACS", acsKeys)) {
    providers.push(createAcsEmailProvider({ connectionString: values.ACS_EMAIL_CONNECTION_STRING! }));
  }
  if (enabled("OCI", ociKeys)) {
    providers.push(createOciEmailProvider({
      endpoint: values.OCI_EMAIL_ENDPOINT!,
      region: values.OCI_EMAIL_REGION!,
      tenancyOcid: values.OCI_EMAIL_TENANCY_OCID!,
      userOcid: values.OCI_EMAIL_USER_OCID!,
      fingerprint: values.OCI_EMAIL_FINGERPRINT!,
      privateKey: values.OCI_EMAIL_PRIVATE_KEY!,
      compartmentOcid: values.OCI_EMAIL_COMPARTMENT_OCID!,
    }));
  }
  return providers;
}

export function createSelectedEmailProvider(env: Record<string, unknown>): EmailProvider | undefined {
  const values = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) as Record<string, string>;
  const configured = createOptionalEmailProviders(values);
  const selected = values.EMAIL_PROVIDER ?? (configured.length > 1 ? "acs-email" : undefined);
  if (!selected) return configured[0];
  const provider = configured.find((candidate) => candidate.name === selected);
  if (!provider) throw new Error(`EMAIL_PROVIDER=${selected} is not fully configured`);
  return provider;
}

async function deterministicUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256Base64(value: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function assertMessage(message: CampaignEmail): void {
  if (!message.idempotencyKey.trim()) throw new Error("Email idempotency key is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.from)) throw new Error("A valid verified sender address is required");
  if (!message.to.length || message.to.some((address) => !address.includes("@"))) throw new Error("At least one valid email recipient is required");
  if (!message.subject.trim()) throw new Error("Email subject is required");
  if (!message.text && !message.html) throw new Error("Email must include plain text or HTML content");
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function headerValue(response: Response, key: string): string | undefined {
  return response.headers.get(key) ?? undefined;
}

function extractAcsOperationId(bodyId: string | undefined, operationLocation: string | undefined, endpoint: string): string | undefined {
  const isGuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (bodyId && isGuid(bodyId)) return bodyId;
  if (!operationLocation) return undefined;
  try {
    const location = new URL(operationLocation);
    if (location.origin !== endpoint) return undefined;
    const match = location.pathname.match(/\/emails\/operations\/([^/]+)\/?$/i);
    const operationId = match?.[1];
    return operationId && isGuid(operationId) ? operationId : undefined;
  } catch {
    return undefined;
  }
}

function providerError(
  provider: EmailSendResult["provider"],
  status: number,
  payload: Record<string, unknown>,
  responseCode: string | undefined,
  requestId: string | null,
): EmailProviderRequestError {
  const rawCode = responseCode ?? stringField(payload, "code") ?? "request_failed";
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : "provider_error";
  const safeRequestId = requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? requestId : undefined;
  const disposition = status >= 400 && status < 500 && status !== 408 && status !== 409 ? "rejected" : "unknown";
  return new EmailProviderRequestError(provider, status, code, disposition, safeRequestId);
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}
