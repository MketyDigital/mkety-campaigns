import assert from "node:assert/strict";
import test from "node:test";
import type { DomainRepository } from "./service.js";
import { createOptionalEmailDomainProvider, createOptionalTenantDomainService } from "./runtime.js";

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

test("OCI domain runtime rejects incomplete management credentials", () => {
  assert.throws(() => createOptionalEmailDomainProvider({ EMAIL_PROVIDER: "oci-email-delivery", OCI_EMAIL_REGION: "eu-frankfurt-1" }), /OCI Email Delivery domain management configuration is incomplete/);
});

test("OCI domain runtime is selected with the OCI Email Delivery adapter", () => {
  const provider = createOptionalEmailDomainProvider({
    EMAIL_PROVIDER: "oci-email-delivery", OCI_EMAIL_REGION: "eu-frankfurt-1", OCI_EMAIL_TENANCY_OCID: "tenancy",
    OCI_EMAIL_USER_OCID: "user", OCI_EMAIL_FINGERPRINT: "01:02", OCI_EMAIL_PRIVATE_KEY: "pem",
    OCI_EMAIL_COMPARTMENT_OCID: "compartment",
  });
  assert.ok(provider);
  assert.equal(typeof provider.createDomain, "function");
  assert.equal(typeof provider.createSenderUsername, "function");
});
