# Optional backup storage credentials

OCI and Azure credentials are not required to run the app. Add them as Coolify environment secrets only when you are ready to enable each backup target. Never commit these values or paste the secret values into chat.

## Azure Blob Storage

The current adapter reads these variables:

| Variable | Value |
| --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | Full connection string for the selected storage account key |
| `AZURE_STORAGE_CONTAINER` | Name of the blob container used for campaign backups |

To find the connection string:

1. Open the Azure portal and select the **Storage account** intended for these backups.
2. In the resource menu, open **Security + networking → Access keys**.
3. Select **Show keys**.
4. Copy the **Connection string** under **key1** into `AZURE_STORAGE_CONNECTION_STRING` in Coolify.
5. Create a private blob container for this app, then enter its name in `AZURE_STORAGE_CONTAINER`.

The connection string contains an account access key with broad storage-account access. Prefer a dedicated storage account for this app, keep the container private, and store the connection string only in Coolify's secret environment settings. Microsoft documents the portal path and key handling [here](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-keys-manage).

## OCI Object Storage

The current S3-compatible adapter reads these variables:

| Variable | Value |
| --- | --- |
| `OCI_OBJECT_STORAGE_ENDPOINT` | `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com` |
| `OCI_OBJECT_STORAGE_REGION` | OCI region identifier, such as `eu-frankfurt-1` |
| `OCI_OBJECT_STORAGE_ACCESS_KEY_ID` | Access Key from an OCI Customer Secret Key |
| `OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY` | Secret Key from that same Customer Secret Key |
| `OCI_OBJECT_STORAGE_BUCKET` | Exact Object Storage bucket name |

To find or create the values:

1. In the OCI Console, use a dedicated IAM user for this app with access limited to the backup bucket.
2. Open the user profile menu in the upper-right, choose **My profile/User settings → Customer secret keys**, and create a Customer Secret Key. Copy the **Secret Key** at creation; OCI will not show it again. The associated **Access Key** remains visible on that page.
3. Open **Object Storage & Archive Storage → Overview** to find the tenancy's Object Storage namespace. The namespace is not the bucket name.
4. Select the OCI region where the bucket lives and copy the region identifier shown in the Console.
5. Open **Object Storage & Archive Storage → Buckets** and create/select the backup bucket. Copy its exact bucket name.
6. Build the endpoint from the namespace and region using the format above, then add all five values to Coolify secrets.
7. Keep the bucket's default tier as **Standard** and configure an Object Lifecycle Management rule for its backup objects to move them to **Infrequent Access** after the chosen age. Do not choose Archive for this workflow.

OCI's S3 compatibility documentation gives the endpoint pattern and Customer Secret Key requirements [here](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm). Its tier documentation explains that Infrequent Access is assigned per object and has a 31-day minimum retention period plus retrieval fees [here](https://docs.oracle.com/iaas/Content/Object/Concepts/understandingstoragetiers.htm).

## Coolify entry names

Add the exact names below as secrets/environment variables on the MKETY Campaigns service. Do not add Azure or OCI values to GitHub Actions or `.env.example` with real values.

```text
AZURE_STORAGE_CONNECTION_STRING
AZURE_STORAGE_CONTAINER
OCI_OBJECT_STORAGE_ENDPOINT
OCI_OBJECT_STORAGE_REGION
OCI_OBJECT_STORAGE_ACCESS_KEY_ID
OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY
OCI_OBJECT_STORAGE_BUCKET
```
