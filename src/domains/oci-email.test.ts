import assert from "node:assert/strict";
import test from "node:test";
import { createOciEmailDomains } from "./oci-email.js";

test("OCI email domain adapter creates a domain and DKIM key, exposes DNS instructions, and adds an approved sender", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  );
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  const pem = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
  const calls: Request[] = [];
  let domainCreated = false;
  let dkimCreated = false;
  const provider = createOciEmailDomains({
    region: "eu-frankfurt-1", tenancyOcid: "tenancy", userOcid: "user", fingerprint: "01:02", privateKey: pem,
    compartmentOcid: "compartment",
    fetcher: async (input, init) => {
      const request = new Request(input, init); calls.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/emailDomains")) {
        domainCreated = true;
        return new Response(JSON.stringify({ emailDomain: { id: "domain-1", name: "mail.example.com" } }), { status: 201 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/dkims")) {
        dkimCreated = true;
        return new Response(JSON.stringify({ dkim: { id: "dkim-1" } }), { status: 201 });
      }
      if (url.pathname.endsWith("/emailDomains")) return new Response(JSON.stringify({ items: domainCreated ? [{ id: "domain-1", name: "mail.example.com", lifecycleState: "ACTIVE", activeDkimId: dkimCreated ? "dkim-1" : null, isSpf: true }] : [] }));
      if (url.pathname.endsWith("/dkims")) return new Response(JSON.stringify({ items: dkimCreated ? [{ id: "dkim-1", lifecycleState: "ACTIVE", dnsSubdomainName: "selector._domainkey.mail.example.com", cnameRecordValue: "selector.dkim.oci.example" }] : [] }));
      if (url.pathname.endsWith("/senders")) return new Response(JSON.stringify({ sender: { id: "sender-1" } }), { status: 201 });
      return new Response("unexpected OCI request", { status: 404 });
    },
  });

  const domain = await provider.createDomain("MAIL.EXAMPLE.COM");
  assert.equal(domain.provisioningState, "Succeeded");
  assert.equal(domain.linked, true);
  assert.equal(domain.verificationRecords.SPF?.value, "v=spf1 include:rp.oracleemaildelivery.com ~all");
  assert.equal(domain.verificationRecords.DKIM?.name, "selector._domainkey.mail.example.com");
  assert.equal(domain.verificationStates.SPF?.status, "Verified");
  assert.equal(domain.verificationStates.DKIM?.status, "Verified");

  const sender = await provider.createSenderUsername("mail.example.com", "info", "Example Updates");
  assert.equal(sender.provisioningState, "Succeeded");
  assert.equal(sender.id, "sender-1");
  assert.ok(calls.every((request) => request.headers.get("authorization")?.startsWith('Signature version="1"')));
  const senderRequest = calls.find((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/senders"));
  assert.deepEqual(await senderRequest?.json(), { compartmentId: "compartment", emailAddress: "info@mail.example.com" });
});

test("OCI email sender provisioning fails closed while SPF or DKIM is not verified", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  );
  const body = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  const provider = createOciEmailDomains({
    region: "eu-frankfurt-1", tenancyOcid: "tenancy", userOcid: "user", fingerprint: "01:02", privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`, compartmentOcid: "compartment",
    fetcher: async (input) => new URL(String(input)).pathname.endsWith("/emailDomains")
      ? new Response(JSON.stringify({ items: [{ id: "domain-1", name: "mail.example.com", lifecycleState: "ACTIVE", isSpf: false }] }))
      : new Response(JSON.stringify({ items: [] })),
  });
  await assert.rejects(provider.createSenderUsername("mail.example.com", "info", "Example"), /must be verified/);
});
