import { createAzureCommunicationDomains, type AzureCommunicationDomains } from "./azure-arm.js";
import { createOciEmailDomains } from "./oci-email.js";
import { createTenantDomainService, type DomainRepository, type TenantDomainService } from "./service.js";

export type AzureDomainEnvironment = {
  EMAIL_PROVIDER?: string;
  AZURE_ARM_TENANT_ID?: string;
  AZURE_ARM_CLIENT_ID?: string;
  AZURE_ARM_CLIENT_SECRET?: string;
  AZURE_SUBSCRIPTION_ID?: string;
  AZURE_RESOURCE_GROUP?: string;
  AZURE_EMAIL_SERVICE_NAME?: string;
  AZURE_COMMUNICATION_SERVICE_NAME?: string;
  OCI_EMAIL_REGION?: string;
  OCI_EMAIL_TENANCY_OCID?: string;
  OCI_EMAIL_USER_OCID?: string;
  OCI_EMAIL_FINGERPRINT?: string;
  OCI_EMAIL_PRIVATE_KEY?: string;
  OCI_EMAIL_COMPARTMENT_OCID?: string;
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
  const provider = createOptionalEmailDomainProvider(env);
  return provider ? createTenantDomainService(repository, provider, env.EMAIL_PROVIDER === "oci-email-delivery" ? "oci-email-delivery" : "acs-email") : undefined;
}

export function createOptionalEmailDomainProvider(env: AzureDomainEnvironment): AzureCommunicationDomains | undefined {
  if (env.EMAIL_PROVIDER === "oci-email-delivery") {
    const keys = ["OCI_EMAIL_REGION", "OCI_EMAIL_TENANCY_OCID", "OCI_EMAIL_USER_OCID", "OCI_EMAIL_FINGERPRINT", "OCI_EMAIL_PRIVATE_KEY", "OCI_EMAIL_COMPARTMENT_OCID"] as const;
    if (keys.some((key) => !env[key]?.trim())) throw new Error("OCI Email Delivery domain management configuration is incomplete");
    return createOciEmailDomains({
      region: env.OCI_EMAIL_REGION!, tenancyOcid: env.OCI_EMAIL_TENANCY_OCID!, userOcid: env.OCI_EMAIL_USER_OCID!,
      fingerprint: env.OCI_EMAIL_FINGERPRINT!, privateKey: env.OCI_EMAIL_PRIVATE_KEY!, compartmentOcid: env.OCI_EMAIL_COMPARTMENT_OCID!,
    });
  }
  if (env.EMAIL_PROVIDER && env.EMAIL_PROVIDER !== "acs-email") throw new Error("Unsupported EMAIL_PROVIDER for tenant domain setup");
  return createOptionalAzureDomainProvider(env);
}

export function createOptionalAzureDomainProvider(env: AzureDomainEnvironment): AzureCommunicationDomains | undefined {
  const configured = REQUIRED_KEYS.filter((key) => Boolean(env[key]?.trim()));
  if (configured.length === 0) return undefined;
  if (configured.length !== REQUIRED_KEYS.length) {
    throw new Error("Azure domain management configuration is incomplete");
  }
  return createAzureCommunicationDomains({
    tenantId: env.AZURE_ARM_TENANT_ID!,
    clientId: env.AZURE_ARM_CLIENT_ID!,
    clientSecret: env.AZURE_ARM_CLIENT_SECRET!,
    subscriptionId: env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: env.AZURE_RESOURCE_GROUP!,
    emailService: env.AZURE_EMAIL_SERVICE_NAME!,
    communicationService: env.AZURE_COMMUNICATION_SERVICE_NAME!,
  });
}
