import assert from "node:assert/strict";
import test from "node:test";
import { createAzureCommunicationDomains } from "./azure-arm.js";

const config = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "client-secret",
  subscriptionId: "subscription-1",
  resourceGroup: "campaigns-rg",
  emailService: "campaigns-email",
  communicationService: "campaigns-comm",
};

function tokenResponse() {
  return Response.json({ access_token: "arm-token", expires_in: 3600 });
}

test("creates a customer-managed Azure email domain and returns provider DNS records", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createAzureCommunicationDomains({
    ...config,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("oauth2/v2.0/token")) return tokenResponse();
      return Response.json({
        id: "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
        name: "mail.example.com",
        properties: {
          domainManagement: "CustomerManaged",
          provisioningState: "Running",
          verificationRecords: { Domain: { type: "TXT", name: "@", value: "verify-me", ttl: 3600 } },
          verificationStates: { Domain: { status: "NotStarted" } },
        },
      }, { status: 201 });
    },
  });

  const domain = await client.createDomain("Mail.Example.com");

  assert.equal(domain.name, "mail.example.com");
  assert.equal(domain.provisioningState, "Running");
  assert.equal(domain.verificationRecords.Domain?.value, "verify-me");
  assert.equal(domain.linked, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /domains\/mail.example.com\?api-version=/);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    location: "Global",
    properties: { domainManagement: "CustomerManaged", userEngagementTracking: "Disabled" },
  });
});

test("rejects URL-like or malformed domain input before calling Azure", async () => {
  let calls = 0;
  const client = createAzureCommunicationDomains({
    ...config,
    fetcher: async () => { calls++; return tokenResponse(); },
  });

  await assert.rejects(client.createDomain("https://mail.example.com/path"), /valid domain/);
  assert.equal(calls, 0);
});

test("links a verified domain without removing other linked email domains", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createAzureCommunicationDomains({
    ...config,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("oauth2/v2.0/token")) return tokenResponse();
      if (url.includes("/domains/mail.example.com?")) {
        return Response.json({
          id: "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
          properties: {
            provisioningState: "Succeeded",
            verificationRecords: { Domain: { type: "TXT", name: "@", value: "token", ttl: 3600 } },
            verificationStates: { Domain: { status: "Verified" } },
          },
        });
      }
      if (url.includes("/communicationServices") && init?.method !== "PATCH") {
        return Response.json({ properties: { linkedDomains: ["/existing/domain"] } }, { headers: { etag: "v1" } });
      }
      return Response.json({ properties: { linkedDomains: ["/existing/domain", "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com"] } });
    },
  });

  await client.linkVerifiedDomain("mail.example.com");

  const patch = calls.find((call) => call.init.method === "PATCH");
  assert.ok(patch);
  assert.deepEqual(JSON.parse(String(patch.init.body)), {
    properties: {
      linkedDomains: [
        "/existing/domain",
        "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
      ],
    },
  });
});

test("retries a concurrent linked-domain update using the latest Azure resource version", async () => {
  const patches: Array<{ ifMatch: string | null; linkedDomains: string[] }> = [];
  let communicationReads = 0;
  const client = createAzureCommunicationDomains({
    ...config,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2/v2.0/token")) return tokenResponse();
      if (url.includes("/domains/mail.example.com?")) {
        return Response.json({
          id: "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
          properties: {
            provisioningState: "Succeeded",
            verificationRecords: { Domain: { type: "TXT", name: "@", value: "token", ttl: 3600 } },
            verificationStates: { Domain: { status: "Verified" } },
          },
        });
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { properties: { linkedDomains: string[] } };
        const ifMatch = new Headers(init.headers).get("if-match");
        patches.push({ ifMatch, linkedDomains: body.properties.linkedDomains });
        if (patches.length === 1) return Response.json({ error: { code: "PreconditionFailed" } }, { status: 412 });
        return Response.json({ properties: body.properties });
      }
      communicationReads++;
      return communicationReads === 1
        ? Response.json({ properties: { linkedDomains: ["/existing/domain"] } }, { headers: { etag: "v1" } })
        : Response.json({ properties: { linkedDomains: ["/existing/domain", "/concurrent/domain"] } }, { headers: { etag: "v2" } });
    },
  });

  await client.linkVerifiedDomain("mail.example.com");

  assert.equal(patches[0]?.ifMatch, "v1");
  assert.equal(patches[1]?.ifMatch, "v2");
  assert.deepEqual(patches[1]?.linkedDomains, [
    "/existing/domain",
    "/concurrent/domain",
    "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
  ]);
});

test("refuses to link a domain until all provider-published verification records are verified", async () => {
  const client = createAzureCommunicationDomains({
    ...config,
    fetcher: async (input) => {
      if (String(input).includes("oauth2/v2.0/token")) return tokenResponse();
      return Response.json({
        id: "/subscriptions/subscription-1/resourceGroups/campaigns-rg/providers/Microsoft.Communication/emailServices/campaigns-email/domains/mail.example.com",
        properties: {
          provisioningState: "Succeeded",
          verificationRecords: { Domain: { type: "TXT", name: "@", value: "token", ttl: 3600 } },
          verificationStates: { Domain: { status: "NotStarted" } },
        },
      });
    },
  });

  await assert.rejects(client.linkVerifiedDomain("mail.example.com"), /DNS verification is incomplete/);
});
