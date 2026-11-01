import { createAzureCommunicationDomains } from "./azure-arm.js";
import { createTenantDomainService, type DomainRepository, type TenantDomainService } from "./service.js";

export type AzureDomainEnvironment = {
  AZURE_ARM_TENANT_ID?: string;
  AZURE_ARM_CLIENT_ID?: string;
  AZURE_ARM_CLIENT_SECRET?: string;
  AZURE_SUBSCRIPTION_ID?: string;
  AZURE_RESOURCE_GROUP?: string;
  AZURE_EMAIL_SERVICE_NAME?: string;
  AZURE_COMMUNICATION_SERVICE_NAME?: string;
};

const REQUIRED_KEYS: (keyof AzureDomainEnvironment)[] = [
  "AZURE_ARM_TENANT_ID",
  "AZURE_ARM_CLIENT_ID",
  "AZURE_ARM_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_RESOURCE_GROUP",
  "AZURE_EMAIL_SERVICE_NAME",
  "AZURE_COMMUNICATION_SERVICE_NAME",
];

export function createOptionalTenantDomainService(
  repository: DomainRepository,
  env: AzureDomainEnvironment,
): TenantDomainService | undefined {
  const configured = REQUIRED_KEYS.filter((key) => Boolean(env[key]?.trim()));
  if (configured.length === 0) return undefined;
  if (configured.length !== REQUIRED_KEYS.length) {
    throw new Error("Azure domain management configuration is incomplete");
  }
  return createTenantDomainService(repository, createAzureCommunicationDomains({
    tenantId: env.AZURE_ARM_TENANT_ID!,
    clientId: env.AZURE_ARM_CLIENT_ID!,
    clientSecret: env.AZURE_ARM_CLIENT_SECRET!,
    subscriptionId: env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: env.AZURE_RESOURCE_GROUP!,
    emailService: env.AZURE_EMAIL_SERVICE_NAME!,
    communicationService: env.AZURE_COMMUNICATION_SERVICE_NAME!,
  }));
}
