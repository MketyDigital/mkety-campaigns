export type CampaignEmail = {
  /** Stable delivery job key used to make provider requests retry-safe where supported. */
  idempotencyKey: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
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
}

type Fetcher = typeof fetch;

export function createAcsEmailProvider(config: {
  connectionString: string;
  sender: string;
  fetcher?: Fetcher;
}): EmailProvider {
  const parsed = parseAcsConnectionString(config.connectionString);
  const sender = required(config.sender, "ACS_EMAIL_SENDER");
  const fetcher = config.fetcher ?? fetch;

  return {
    name: "acs-email",
    async send(message) {
      assertMessage(message);
      const url = new URL("/emails:send?api-version=2023-03-31", parsed.endpoint);
      const body = JSON.stringify({
        senderAddress: sender,
        recipients: { to: message.to.map((address) => ({ address })) },
        content: {
          subject: message.subject,
          ...(message.text ? { plainText: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
        },
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
      if (!response.ok) throw providerError("ACS email", response.status, payload);
      return {
        provider: "acs-email",
        providerMessageId: stringField(payload, "id") ?? headerValue(response, "operation-location"),
        requestId: operationId,
        acceptedAt: new Date().toISOString(),
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
  sender: string;
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
  const sender = required(config.sender, "OCI_EMAIL_SENDER");
  const fetcher = config.fetcher ?? fetch;

  return {
    name: "oci-email-delivery",
    async send(message) {
      assertMessage(message);
      const url = new URL("/20220926/actions/submitEmail", endpoint);
      const body = JSON.stringify({
        sender: { senderAddress: { email: sender }, compartmentId: compartmentOcid },
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
      const key = await importOciPrivateKey(privateKey);
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
      if (!response.ok) throw providerError("OCI Email Delivery", response.status, payload);
      return {
        provider: "oci-email-delivery",
        providerMessageId: stringField(payload, "messageId") ?? stringField(payload, "id"),
        requestId: headerValue(response, "opc-request-id"),
        acceptedAt: new Date().toISOString(),
      };
    },
  };
}

export function createOptionalEmailProviders(env: Record<string, string | undefined>): EmailProvider[] {
  const acsKeys = ["ACS_EMAIL_CONNECTION_STRING", "ACS_EMAIL_SENDER"] as const;
  const ociKeys = [
    "OCI_EMAIL_ENDPOINT",
    "OCI_EMAIL_REGION",
    "OCI_EMAIL_TENANCY_OCID",
    "OCI_EMAIL_USER_OCID",
    "OCI_EMAIL_FINGERPRINT",
    "OCI_EMAIL_PRIVATE_KEY",
    "OCI_EMAIL_COMPARTMENT_OCID",
    "OCI_EMAIL_SENDER",
  ] as const;
  const enabled = (name: string, keys: readonly string[]) => {
    const present = keys.filter((key) => Boolean(env[key]));
    if (present.length > 0 && present.length !== keys.length) {
      throw new Error(`${name} email provider is partially configured; missing: ${keys.filter((key) => !env[key]).join(", ")}`);
    }
    return present.length === keys.length;
  };

  const providers: EmailProvider[] = [];
  if (enabled("ACS", acsKeys)) {
    providers.push(createAcsEmailProvider({ connectionString: env.ACS_EMAIL_CONNECTION_STRING!, sender: env.ACS_EMAIL_SENDER! }));
  }
  if (enabled("OCI", ociKeys)) {
    providers.push(createOciEmailProvider({
      endpoint: env.OCI_EMAIL_ENDPOINT!,
      region: env.OCI_EMAIL_REGION!,
      tenancyOcid: env.OCI_EMAIL_TENANCY_OCID!,
      userOcid: env.OCI_EMAIL_USER_OCID!,
      fingerprint: env.OCI_EMAIL_FINGERPRINT!,
      privateKey: env.OCI_EMAIL_PRIVATE_KEY!,
      compartmentOcid: env.OCI_EMAIL_COMPARTMENT_OCID!,
      sender: env.OCI_EMAIL_SENDER!,
    }));
  }
  return providers;
}

async function importOciPrivateKey(pem: string): Promise<CryptoKey> {
  const match = pem.trim().match(/^-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----$/);
  if (!match) throw new Error("OCI_EMAIL_PRIVATE_KEY must be an unencrypted PKCS#8 PEM private key");
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(base64ToBytes(match[1])), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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

function providerError(provider: string, status: number, payload: Record<string, unknown>): Error {
  const code = stringField(payload, "code") ?? "request_failed";
  return new Error(`${provider} request failed (${status}): ${code}`);
}
