# Email provider credentials

Provider adapters use fetch-compatible HTTP APIs so the same provider contract can run under Node on Coolify and a Cloudflare Worker. Provider credentials are optional in development. Do not add live provider credentials to the ordinary CI workflow: its tests use mocked HTTP responses and do not send email.

For the deployed app, add these names to the MKETY Campaigns service in Coolify. If a future trusted GitHub Actions workflow needs to run an explicit integration check, use protected GitHub Environment secrets rather than exposing production credentials to every repository workflow. Keep live sending disabled until domain, sender, consent, and safety checks are signed off.

## Azure Communication Services Email

The adapter uses the ACS Email REST API. It needs the connection string for the **Communication Services resource connected to the Email domain**, plus the approved MailFrom address.

| Variable | Value |
| --- | --- |
| `ACS_EMAIL_CONNECTION_STRING` | The full `endpoint=...;accesskey=...` connection string from the Communication Services resource |
| `ACS_EMAIL_SENDER` | The approved sender / MailFrom address on the linked Email domain |

Find the values in Azure Portal:

1. Open the **Communication Services** resource linked to your Email domain.
2. Under **Settings**, open **Keys** (sometimes displayed as **Keys and connection strings**).
3. Copy a **Connection string** into `ACS_EMAIL_CONNECTION_STRING`.
4. In the linked Email Communication Service resource, open its domain and copy the verified **MailFrom** address into `ACS_EMAIL_SENDER`.

The connection string includes the endpoint and access key. Keep it in Coolify as a secret. Microsoft documents that the endpoint and key are in the Communication Services resource's Keys panel and that the sender must be a valid MailFrom address on the linked domain ([send-email quickstart](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/send-email)).

## OCI Email Delivery

The adapter uses OCI's HTTPS SubmitEmail API, not the S3/Object Storage keys and not SMTP credentials. It signs HTTPS requests with an OCI API signing key.

| Variable | Value |
| --- | --- |
| `OCI_EMAIL_ENDPOINT` | Public HTTPS endpoint copied from Email Delivery's regional **Configuration** page |
| `OCI_EMAIL_REGION` | OCI region identifier where the approved sender exists |
| `OCI_EMAIL_TENANCY_OCID` | Tenancy OCID |
| `OCI_EMAIL_USER_OCID` | OCID of the dedicated IAM user whose API signing key is registered |
| `OCI_EMAIL_FINGERPRINT` | Fingerprint of the registered public API signing key |
| `OCI_EMAIL_PRIVATE_KEY` | The corresponding unencrypted PKCS#8 PEM private key; shown below as a secret, never committed |
| `OCI_EMAIL_COMPARTMENT_OCID` | Compartment OCID containing the approved sender |
| `OCI_EMAIL_SENDER` | Approved sender email address in the selected region |

Create and find the values:

1. Create a dedicated IAM user for the app and grant its group the policy `Allow group <identity-domain>/<group> to use email-family in compartment <compartment>`.
2. Generate an RSA API signing key pair. Register the **public** key under **Identity & Security → Domains → [domain] → Users → [user] → API Keys → Add API Key**. Keep the private key on the trusted machine used for setup, and copy the displayed fingerprint.
3. Copy the user's OCID from the user's details and the tenancy OCID from the tenancy details page.
4. In **Developer Services → Application Integration → Email Delivery → Configuration**, copy the HTTPS **Public Endpoint** and note the region. Approved senders and email domains are regional.
5. Copy the OCID of the compartment containing the approved sender, and the approved sender email address.
6. Add the values to Coolify using the exact names in the table. Store the whole private PEM as a secret value.

If the generated key begins with `BEGIN RSA PRIVATE KEY`, convert it to unencrypted PKCS#8 before adding it:

```sh
openssl pkcs8 -topk8 -nocrypt -in oci-api-key.pem -out oci-api-key-pkcs8.pem
```

Oracle documents HTTPS submissions and API-key authentication [here](https://docs.oracle.com/en/learn/send-email-with-ociemaildelivery-http/), and lists the regional HTTPS endpoint in the Email Delivery **Configuration** page [here](https://docs.oracle.com/en-us/iaas/Content/Email/Concepts/email-submission-configure-https-connection.htm). OCI request signing requires the tenancy/user/fingerprint key ID and signed request headers [here](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm).

## Secret names

```text
ACS_EMAIL_CONNECTION_STRING
ACS_EMAIL_SENDER
OCI_EMAIL_ENDPOINT
OCI_EMAIL_REGION
OCI_EMAIL_TENANCY_OCID
OCI_EMAIL_USER_OCID
OCI_EMAIL_FINGERPRINT
OCI_EMAIL_PRIVATE_KEY
OCI_EMAIL_COMPARTMENT_OCID
OCI_EMAIL_SENDER
```

The existing backup variables `AZURE_STORAGE_CONNECTION_STRING` and `OCI_OBJECT_STORAGE_*` are separate credentials for Azure Blob and OCI Object Storage. They are not interchangeable with these email provider credentials.
