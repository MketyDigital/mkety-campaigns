# Provision backup storage and Azure domain management

Run these commands in the respective provider Cloud Shells. They create infrastructure; they do not upload backups or send messages. Do not paste credential values into chat.

## OCI: create a private, empty backup bucket

The bucket belongs in a dedicated `mkety-backups` compartment, separate from the Email Delivery compartment. The bucket's default tier is Standard; OCI Infrequent Access is an object-level choice later. This command does not enable application backups or upload objects.

Run once in OCI Cloud Shell:

```bash
set -euo pipefail

TENANCY_OCID="$(awk -F= '/^tenancy=/{print $2; exit}' "$OCI_CLI_CONFIG_FILE")"
REGION="eu-frankfurt-1"
COMPARTMENT_NAME="mkety-backups"
BUCKET_NAME="mkety-central-backups"

BACKUP_COMPARTMENT_OCID="$(oci iam compartment create \
  --compartment-id "$TENANCY_OCID" \
  --name "$COMPARTMENT_NAME" \
  --description "Private backup storage for Mkety services" \
  --wait-for-state ACTIVE \
  --query data.id --raw-output)"

NAMESPACE="$(oci os ns get --region "$REGION" --query data --raw-output)"

oci os bucket create \
  --region "$REGION" \
  --compartment-id "$BACKUP_COMPARTMENT_OCID" \
  --namespace "$NAMESPACE" \
  --name "$BUCKET_NAME" \
  --storage-tier Standard \
  --public-access-type NoPublicAccess \
  --query 'data.{name:name,compartment:compartment-id,namespace:namespace,tier:storage-tier,publicAccess:public-access-type}' \
  --output json

printf 'Compartment OCID: %s\n' "$BACKUP_COMPARTMENT_OCID"
printf 'Namespace: %s\n' "$NAMESPACE"
printf 'OCI_OBJECT_STORAGE_REGION=%s\n' "$REGION"
printf 'OCI_OBJECT_STORAGE_BUCKET=%s\n' "$BUCKET_NAME"
printf 'OCI_OBJECT_STORAGE_ENDPOINT=https://%s.compat.objectstorage.%s.oci.customer-oci.com\n' "$NAMESPACE" "$REGION"
```

The compartment and bucket names must be unused. If either create command says the resource already exists, stop and inspect it instead of changing names or creating duplicates. Confirm `publicAccess` is `NoPublicAccess` and `tier` is `Standard`. Keep the printed endpoint and non-secret values. Do not enable auto-tiering.

An empty bucket has no stored-data capacity charge. Requests can be metered. No customer secret key is needed until the OCI adapter is implemented and explicitly enabled. When that time comes, create a dedicated OCI group/policy restricted to this bucket and create an S3 Customer Secret Key; do not reuse the OCI API signing private key as the S3 secret.

## Azure: create a narrowly scoped domain-management identity

ACS_EMAIL_CONNECTION_STRING is for email data-plane use; it cannot create/link domains. This Entra app is separate. It has read/write only for email domain resources and the Communication Service's linkedDomains property. Its custom role is assigned at the two individual resource scopes, never at subscription or resource-group scope. Run once in Azure Cloud Shell.

First verify the exact provider operations are available:

```bash
az account set --subscription "693b87c2-606b-4cd5-8ebb-3b8f36a1a9ad"
az provider operation list --namespace Microsoft.Communication \
  --query "[].name" -o tsv | grep -iE 'EmailServices/domains/(read|write)|CommunicationServices/(read|write)'
```

Expect the four operations for domain read/write and Communication Service read/write. If any are missing, stop and share only the operation names; don't broaden the role to Contributor.

Then create the app, role, assignments, and a short-lived client secret:

```bash
set -euo pipefail

SUBSCRIPTION_ID="693b87c2-606b-4cd5-8ebb-3b8f36a1a9ad"
RESOURCE_GROUP="mkety_group"
EMAIL_SERVICE_NAME="MketyEmailMarket2"
COMMUNICATION_SERVICE_NAME="mketycomm2"
ROLE_NAME="Mkety Campaigns Domain Provisioner"
ROLE_FILE="$HOME/mkety-campaign-domain-role.json"

az account set --subscription "$SUBSCRIPTION_ID"
TENANT_ID="$(az account show --query tenantId -o tsv)"
RG_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"

EMAIL_SERVICE_ID="$(az resource show -g "$RESOURCE_GROUP" -n "$EMAIL_SERVICE_NAME" \
  --resource-type Microsoft.Communication/emailServices --query id -o tsv)"
COMMUNICATION_SERVICE_ID="$(az resource show -g "$RESOURCE_GROUP" -n "$COMMUNICATION_SERVICE_NAME" \
  --resource-type Microsoft.Communication/communicationServices --query id -o tsv)"

test -n "$EMAIL_SERVICE_ID"
test -n "$COMMUNICATION_SERVICE_ID"

APP_ID="$(az ad app create --display-name "Mkety Campaigns Domain Manager" \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)"
az ad sp create --id "$APP_ID" --only-show-errors >/dev/null
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

cat > "$ROLE_FILE" <<EOF
{
  "Name": "$ROLE_NAME",
  "IsCustom": true,
  "Description": "Create/read customer-managed email domains and link them to Mkety Campaigns ACS.",
  "Actions": [
    "Microsoft.Communication/EmailServices/domains/read",
    "Microsoft.Communication/EmailServices/domains/write",
    "Microsoft.Communication/CommunicationServices/read",
    "Microsoft.Communication/CommunicationServices/write"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": ["$RG_SCOPE"]
}
EOF

az role definition create --role-definition "$ROLE_FILE" --only-show-errors >/dev/null
az role assignment create --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal --role "$ROLE_NAME" \
  --scope "$EMAIL_SERVICE_ID" --only-show-errors >/dev/null
az role assignment create --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal --role "$ROLE_NAME" \
  --scope "$COMMUNICATION_SERVICE_ID" --only-show-errors >/dev/null

CLIENT_SECRET="$(az ad app credential reset --id "$APP_ID" \
  --display-name "Coolify Campaigns portal (rotate by 2027-01-30)" \
  --end-date "2027-01-30T00:00:00Z" --query password -o tsv)"

printf 'AZURE_ARM_TENANT_ID=%s\n' "$TENANT_ID"
printf 'AZURE_ARM_CLIENT_ID=%s\n' "$APP_ID"
printf 'AZURE_ARM_CLIENT_SECRET=%s\n' "$CLIENT_SECRET"
unset CLIENT_SECRET
```

Copy the three values directly from your Cloud Shell into GitHub **Actions secrets** named `AZURE_ARM_TENANT_ID`, `AZURE_ARM_CLIENT_ID`, and `AZURE_ARM_CLIENT_SECRET`. The last value is shown once. Never paste it here or commit it. Rotate it before the printed expiry.

Provide these non-secret settings to the app runtime as environment variables: `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_EMAIL_SERVICE_NAME`, `AZURE_COMMUNICATION_SERVICE_NAME`. Keep them separate from `ACS_EMAIL_CONNECTION_STRING`.

This identity can create/link a custom email domain in Mkety's Azure resources. It cannot edit DNS at a customer's registrar. The portal must show the TXT/SPF/DKIM records for the customer to add and keep sending disabled until Azure reports domain verification complete.

## SMS provider research checkpoint

The first provider shortlist is Telnyx, not ACS SMS. Current published US prices: Telnyx lists $0.004 per SMS part plus carrier pass-through and no platform fee; Twilio lists $0.0083 per segment plus carrier fees; Plivo lists $0.0077 plus carrier surcharges. Number rental, A2P registration, and destination-country charges are extra. These are not global quotes. Pick actual SMS provider and sender only after target countries are known.
