import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcsEmailProvider,
  createOptionalEmailProviders,
  createOciEmailProvider,
  type CampaignEmail,
} from "./providers.js";

const message: CampaignEmail = {
  idempotencyKey: "campaign-job-42",
  from: "hello@tenant.example",
  to: ["person@example.net"],
  subject: "A test",
  text: "Plain text",
  html: "<p>Plain text</p>",
};

test("ACS provider sends a signed request and returns the accepted operation", async () => {
  let captured: Request | undefined;
  const provider = createAcsEmailProvider({
    connectionString: "endpoint=https://example.communication.azure.com/;accesskey=YWJjZA==",
    fetcher: async (input, init) => {
      captured = new Request(input, init);
      return new Response(JSON.stringify({ id: "op-123", status: "Running" }), {
        status: 202,
        headers: { "Operation-Location": "https://example.communication.azure.com/emails/operations/op-123" },
      });
    },
  });

  const result = await provider.send(message);
  assert.equal(result.provider, "acs-email");
  assert.equal(result.providerMessageId, "op-123");
  assert.ok(captured);
  assert.match(captured.headers.get("authorization") ?? "", /^HMAC-SHA256 /);
  assert.equal(captured.headers.get("operation-id")?.length, 36);
  const bodyText = await captured.clone().text();
  assert.deepEqual(JSON.parse(bodyText), {
    senderAddress: "hello@tenant.example",
    recipients: { to: [{ address: "person@example.net" }] },
    content: { subject: "A test", plainText: "Plain text", html: "<p>Plain text</p>" },
    userEngagementTrackingDisabled: true,
  });
  const date = captured.headers.get("x-ms-date") ?? "";
  const contentHash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText)))));
  const stringToSign = `POST\n${new URL(captured.url).pathname}${new URL(captured.url).search}\n${date};${new URL(captured.url).host};${contentHash}`;
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob("YWJjZA=="), (char) => char.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = captured.headers.get("authorization")?.split("Signature=")[1] ?? "";
  assert.equal(await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(stringToSign)), true);
});

test("OCI provider signs and submits through the HTTPS endpoint", async () => {
  const { privateKey, publicKey } = await makeTestKeyPair();
  let captured: Request | undefined;
  const provider = createOciEmailProvider({
    endpoint: "https://cell1.submit.email.eu-frankfurt-1.oci.oraclecloud.com",
    region: "eu-frankfurt-1",
    tenancyOcid: "ocid1.tenancy.oc1..test",
    userOcid: "ocid1.user.oc1..test",
    fingerprint: "01:02:03:04",
    privateKey,
    compartmentOcid: "ocid1.compartment.oc1..test",
    fetcher: async (input, init) => {
      captured = new Request(input, init);
      return new Response(JSON.stringify({ messageId: "oci-msg-123" }), { status: 202 });
    },
  });

  const result = await provider.send(message);
  assert.equal(result.provider, "oci-email-delivery");
  assert.equal(result.providerMessageId, "oci-msg-123");
  assert.ok(captured);
  assert.match(captured.url, /\/20220926\/actions\/submitEmail$/);
  assert.match(captured.headers.get("authorization") ?? "", /Signature version="1"/);
  assert.match(captured.headers.get("authorization") ?? "", /keyId="ocid1\.tenancy\.oc1\.\.test\/ocid1\.user\.oc1\.\.test\/01:02:03:04"/);
  const payload = await captured.clone().json();
  assert.deepEqual(payload, {
    sender: {
      senderAddress: { email: "hello@tenant.example" },
      compartmentId: "ocid1.compartment.oc1..test",
    },
    recipients: { to: [{ email: "person@example.net" }] },
    subject: "A test",
    bodyText: "Plain text",
    bodyHtml: "<p>Plain text</p>",
  });
  const body = await captured.clone().text();
  const bodyHash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))));
  const date = captured.headers.get("date");
  const signingString = [
    `(request-target): post ${new URL(captured.url).pathname}`,
    `date: ${date}`,
    `host: ${new URL(captured.url).host}`,
    `content-length: ${new TextEncoder().encode(body).byteLength}`,
    "content-type: application/json",
    `x-content-sha256: ${bodyHash}`,
  ].join("\n");
  const authorization = captured.headers.get("authorization") ?? "";
  const signature = authorization.match(/signature="([^"]+)"/)?.[1];
  assert.ok(signature);
  assert.equal(await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
    new TextEncoder().encode(signingString),
  ), true);
});

test("providers surface service failures without echoing credentials", async () => {
  const provider = createAcsEmailProvider({
    connectionString: "endpoint=https://example.communication.azure.com;accesskey=dG9wLXNlY3JldA==",
    fetcher: async () => new Response("provider rejected request", { status: 401 }),
  });
  await assert.rejects(provider.send(message), /ACS email request failed \(401\)/);
  await assert.rejects(provider.send(message), (error: Error) => !error.message.includes("top-secret"));
});

test("email providers remain disabled without credentials and reject partial setup", () => {
  assert.deepEqual(createOptionalEmailProviders({}), []);
  assert.equal(createOptionalEmailProviders({
    ACS_EMAIL_CONNECTION_STRING: "endpoint=https://x.communication.azure.com;accesskey=YQ==",
  }).length, 1);
  assert.throws(() => createOptionalEmailProviders({ OCI_EMAIL_ENDPOINT: "https://oci.example" }), /partially configured/);
});

async function makeTestKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return { privateKey: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
}
