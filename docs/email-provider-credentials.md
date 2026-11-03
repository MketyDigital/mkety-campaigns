# Email provider credentials

Provider adapters use fetch-compatible HTTP APIs so the same provider contract can run under Node on Coolify and a Cloudflare Worker. Provider credentials are optional in development. Do not add live provider credentials to the ordinary CI workflow: its tests use mocked HTTP responses and do not send email.

These are platform-level provider credentials. Tenants do not receive or enter MKETY's ACS connection string or OCI API signing key. Each tenant's verified domain and allowed From addresses belong in tenant-scoped application records. The server must resolve a message's From address from those verified records; it must never trust a From address supplied directly by a browser or API caller. The adapters accept the already-resolved From address on each message so they can serve multiple tenants through a shared provider account.

For the deployed app, add these names to the MKETY Campaigns service in Coolify. If a future trusted GitHub Actions workflow needs to run an explicit integration check, use protected GitHub Environment secrets rather than exposing production credentials to every repository workflow. Campaign delivery is off by default. `EMAIL_CAMPAIGN_SEND_ENABLED=true` enables both the Ops queue action and the Node worker; use it only in a controlled test deployment after domain, sender, consent, and safety checks. `EMAIL_CAMPAIGN_MAX_RECIPIENTS` defaults to 100 and may be set to 1 for the first send. The separate `EMAIL_TEST_SEND_ENABLED` switch permits one fixed test message to the signed-in account email.

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
| `OCI_EMAIL_PRIVATE_KEY` | The corresponding unencrypted RSA PEM private key; PKCS#8 and traditional `RSA PRIVATE KEY` PEM are accepted |
| `OCI_EMAIL_COMPARTMENT_OCID` | Compartment OCID containing the approved sender |
Create and find the values:

1. Create a dedicated IAM user for the app and grant its group the policy `Allow group <identity-domain>/<group> to manage email-family in compartment <compartment>`. This is required for portal domain/DKIM and approved-sender creation; scope it to the dedicated Email compartment.
2. Generate an RSA API signing key pair. Register the **public** key under **Identity & Security → Domains → [domain] → Users → [user] → API Keys → Add API Key**. Keep the private key on the trusted machine used for setup, and copy the displayed fingerprint.
3. Copy the user's OCID from the user's details and the tenancy OCID from the tenancy details page.
4. In **Developer Services → Application Integration → Email Delivery → Configuration**, copy the HTTPS **Public Endpoint** and note the region. Approved senders and email domains are regional.
5. Copy the OCID of the compartment where approved senders will be created.
6. With `EMAIL_PROVIDER=oci-email-delivery`, a tenant adds their domain in the portal. The app creates the OCI Email Delivery domain and DKIM record, then displays the SPF TXT and DKIM CNAME instructions. The tenant publishes them with their DNS host. Refresh verification in the portal; the app creates an OCI approved sender only after SPF and DKIM are active.
7. Add the platform credentials to Coolify using the exact names in the table. Store the whole private PEM as a secret value.

The signer accepts either PEM header format (`BEGIN PRIVATE KEY` or `BEGIN RSA PRIVATE KEY`). Keep the corresponding public key registered with OCI and never commit the private key.

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

Sender addresses are selected per tenant from its verified domain configuration; they are not fixed deployment environment variables. Each sender record is tied to the provider that created it, and campaign jobs route using that stored provider. `EMAIL_PROVIDER` chooses which adapter new domain onboarding and owner test-send use; configure credentials for every provider that existing senders may use.

The existing backup variables `AZURE_STORAGE_CONNECTION_STRING` and `OCI_OBJECT_STORAGE_*` are separate credentials for Azure Blob and OCI Object Storage. They are not interchangeable with these email provider credentials.

## One controlled test message

1. In Coolify, set `EMAIL_PROVIDER=acs-email` or `EMAIL_PROVIDER=oci-email-delivery`, add that provider's credentials, and set `EMAIL_TEST_SEND_ENABLED=true` for the test environment only.
2. Apply the current PostgreSQL migrations and deploy the app.
3. Sign in as a tenant owner with MFA, add a customer-managed email domain in **Sender domains**, publish the DNS records shown by the selected provider, then refresh verification.
4. Open **Sender addresses**, create a username such as `info`, and refresh its status until it reads `ready`.
5. Select **Send test email to your signed-in account**. The app sends a fixed message from that sender to the account email already on the session. It ignores any caller-supplied recipient or From address.
6. Check the inbox and provider status. An HTTP success means the provider accepted the message; it does not guarantee mailbox delivery.
7. Set `EMAIL_TEST_SEND_ENABLED=false` after the check. This test path never enqueues campaigns.

The test action is unavailable while the sender is pending, the provider is unconfigured, or the runtime flag is false. SMS and OCI Object Storage backup remain disabled independently.

## One-recipient campaign check

After the sender test succeeds, create a contact for a mailbox you control and record its real, channel-specific consent evidence. Create an email draft, submit it for review, and approve it as an MFA-enabled Ops user. Set `EMAIL_CAMPAIGN_MAX_RECIPIENTS=1` and `EMAIL_CAMPAIGN_SEND_ENABLED=true` in the isolated test deployment, redeploy, then use the separate **Queue campaign delivery** action in Ops. The queue only includes contacts with current granted consent and no suppression. Check the inbox and provider status; turn the gate back off immediately after the test. A provider acceptance response means queued by ACS, not guaranteed inbox delivery.

Campaign workers route to ACS or OCI using the provider saved on each sender identity. A live send still requires a healthy deployed portal, verified sender domain, configured provider credentials, and an explicitly enabled test or campaign-send gate.
