# Email provider credentials

Provider adapters use fetch-compatible HTTP APIs so the same provider contract can run under Node on Coolify and a Cloudflare Worker. Provider credentials are optional in development. Do not add live provider credentials to the ordinary CI workflow: its tests use mocked HTTP responses and do not send email.

These are platform-level provider credentials. Tenants do not receive or enter MKETY's ACS connection string or OCI API signing key. Each tenant's verified domain and allowed From addresses belong in tenant-scoped application records. The server must resolve a message's From address from those verified records; it must never trust a From address supplied directly by a browser or API caller. The adapters accept the already-resolved From address on each message so they can serve multiple tenants through a shared provider account.

For the deployed app, add these names to the MKETY Campaigns service in Coolify. If a future trusted GitHub Actions workflow needs to run an explicit integration check, use protected GitHub Environment secrets rather than exposing production credentials to every repository workflow. Keep live sending disabled until domain, sender, consent, and safety checks are signed off.

## Azure Communication Services Email

The adapter uses the ACS Email REST API. It needs the connection string for the **Communication Services resource connected to the Email domain**, plus the approved MailFrom address.

| Variable | Value |
| --- | --- |
| `ACS_EMAIL_CONNECTION_STRING` | The full `endpoint=...;accesskey=...` connection string from the Communication Services resource |
Find the values in Azure Portal:

1. Open the **Communication Services** resource linked to your Email domain.
2. Under **Settings**, open **Keys** (sometimes displayed as **Keys and connection strings**).
3. Copy a **Connection string** into `ACS_EMAIL_CONNECTION_STRING`.
4. In the linked Email Communication Service resource, open each verified domain to see its allowed MailFrom addresses. Those addresses are tenant domain configuration, not deployment secrets.

Azure supports linking multiple verified customer domains to one Communication Services resource (currently documented as up to 100 custom domains). Each domain must first be added and verified in Email Communication Services, then linked to the Communication Services resource. Tenant domain onboarding must also check geography compatibility and verification state before enabling a sender.

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
Create and find the values:

1. Create a dedicated IAM user for the app and grant its group the policy `Allow group <identity-domain>/<group> to use email-family in compartment <compartment>`.
2. Generate an RSA API signing key pair. Register the **public** key under **Identity & Security → Domains → [domain] → Users → [user] → API Keys → Add API Key**. Keep the private key on the trusted machine used for setup, and copy the displayed fingerprint.
3. Copy the user's OCID from the user's details and the tenancy OCID from the tenancy details page.
4. In **Developer Services → Application Integration → Email Delivery → Configuration**, copy the HTTPS **Public Endpoint** and note the region. Approved senders and email domains are regional.
5. Copy the OCID of the compartment where approved senders will be created.
6. Add each customer domain to OCI Email Delivery, configure DKIM in that domain's DNS, then create the approved domain sender (`@customer-domain.example`) after DKIM is active. The platform can send from a tenant's verified address only after that tenant/domain is approved in the app and in OCI.
7. Add the platform credentials to Coolify using the exact names in the table. Store the whole private PEM as a secret value.

If the generated key begins with `BEGIN RSA PRIVATE KEY`, convert it to unencrypted PKCS#8 before adding it:

```sh
openssl pkcs8 -topk8 -nocrypt -in oci-api-key.pem -out oci-api-key-pkcs8.pem
```

Oracle documents HTTPS submissions and API-key authentication [here](https://docs.oracle.com/en/learn/send-email-with-ociemaildelivery-http/), and lists the regional HTTPS endpoint in the Email Delivery **Configuration** page [here](https://docs.oracle.com/en-us/iaas/Content/Email/Concepts/email-submission-configure-https-connection.htm). OCI request signing requires the tenancy/user/fingerprint key ID and signed request headers [here](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm).

## Secret names

```text
ACS_EMAIL_CONNECTION_STRING
OCI_EMAIL_ENDPOINT
OCI_EMAIL_REGION
OCI_EMAIL_TENANCY_OCID
OCI_EMAIL_USER_OCID
OCI_EMAIL_FINGERPRINT
OCI_EMAIL_PRIVATE_KEY
OCI_EMAIL_COMPARTMENT_OCID
```

Sender addresses are selected per tenant from its verified domain configuration; they are not fixed deployment environment variables.

The existing backup variables `AZURE_STORAGE_CONNECTION_STRING` and `OCI_OBJECT_STORAGE_*` are separate credentials for Azure Blob and OCI Object Storage. They are not interchangeable with these email provider credentials.
