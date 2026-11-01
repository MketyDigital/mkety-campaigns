import assert from "node:assert/strict";
import test from "node:test";
import type { DomainRepository } from "./service.js";
import { createOptionalTenantDomainService } from "./runtime.js";

const repository = {} as DomainRepository;

test("domain runtime stays disabled when no Azure ARM settings are present", () => {
  assert.equal(createOptionalTenantDomainService(repository, {}), undefined);
});

test("domain runtime rejects partial Azure ARM settings instead of failing later", () => {
  assert.throws(
    () => createOptionalTenantDomainService(repository, { AZURE_ARM_CLIENT_ID: "client-id" }),
    /Azure domain management configuration is incomplete/,
  );
});

test("domain runtime wires the service when all Azure ARM settings are present", () => {
  const service = createOptionalTenantDomainService(repository, {
    AZURE_ARM_TENANT_ID: "tenant",
    AZURE_ARM_CLIENT_ID: "client",
    AZURE_ARM_CLIENT_SECRET: "secret",
    AZURE_SUBSCRIPTION_ID: "subscription",
    AZURE_RESOURCE_GROUP: "group",
    AZURE_EMAIL_SERVICE_NAME: "email",
    AZURE_COMMUNICATION_SERVICE_NAME: "communication",
  });
  assert.ok(service);
  assert.equal(typeof service.create, "function");
});
