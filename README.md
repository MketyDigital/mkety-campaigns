# MKETY Campaigns — Standalone Architecture & Roadmap

Status: email-campaign application foundation implemented; production deployment and live sending are not verified. Owner: MKETY Ops. Updated: 2026-11-14.

**Current implementation and production gates:** [Development status and pilot readiness](docs/operations/development-status.md).

## Current build
- One TypeScript/Hono application with shared routes and separate Node and Cloudflare Workers entry points.
- Coolify on the OCI VM is the first deployment target. It uses PostgreSQL through `DATABASE_URL`; this repo does not provision or change an existing database.
- Optional Cloudflare Workers deployment uses D1 through a binding. D1 is not used by the Coolify deployment.
- R2 is the primary object store. Azure Blob and OCI Object Storage adapters/utilities exist, but no durable background backup or restore job runs yet. OCI is feature-flagged off; its adapter uses object-level Infrequent Access only after explicit activation, requires at least 31 days retention, and blocks application deletes. Normal request handling writes to R2 only.
- SMS uses a provider-neutral contract with a Telnyx adapter. It remains off by default; ACS SMS is not in the initial lineup. Destination-country pricing and sender eligibility are required before activation.
- PostgreSQL and D1 migrations define tenant seats, consent, contacts, suppression, campaigns, idempotent jobs, delivery attempts, delivery-event reconciliation, daily email queue budgets, archive manifests, and audit records.
- Better Auth provides invite-only email/password sign-in and TOTP/backup-code MFA. Tenant API routes and the `/app` dashboard fail closed unless the session has MFA enabled, was created after MFA enrollment, and the user has one active seat on an approved tenant.
- ACS Email and OCI Email Delivery adapters are available as platform-managed providers. Portal domain setup provisions and checks domains and senders through the provider selected by `EMAIL_PROVIDER`; sender records persist their provider and the campaign worker routes each job to that adapter. ACS uses Azure Resource Manager. OCI creates Email Delivery domains and DKIM records, displays required SPF/DKIM DNS records, checks verification, and creates approved senders using the OCI signing key.
- The portal includes customer invitations, Azure sender-domain setup, consent-evidenced manual/CSV contact imports, channel-specific consent withdrawal and suppression, campaign drafts with optional planned send times, tenant review submission, and MFA-protected Ops approval. Approval never sends.
- Email delivery has a durable per-recipient queue for approved email campaigns, an explicit MFA Ops queue action, last-moment consent/suppression checks, opaque unsubscribe tokens and one-click unsubscribe, per-campaign and per-tenant daily queue caps, stable idempotency keys, and manual review for uncertain provider results. Security headers and fail-closed unsubscribe validation are implemented. Campaign sending remains off unless `EMAIL_CAMPAIGN_SEND_ENABLED=true`.
- `EMAIL_PROVIDER` selects the provider used for new domain and sender onboarding and for the fixed owner test-send. Existing senders retain their provider; campaign workers can route to every fully configured provider. A validated provider-event contract, replay-safe reconciliation, and bounce/complaint suppression are implemented, but provider-authenticated event ingestion is not. Templates, segments, reports, provider quotas and burst limits, cost visibility, and automated PostgreSQL backup/restore remain incomplete. A database-backed per-provider minimum-interval throttle exists, but it paces dispatch; it does not enforce vendor quotas, billing limits, or monitoring.

### Run locally
1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a dedicated development PostgreSQL database.
2. Run `npm ci`, then `npm run db:migrate:pg`, then `npm run dev`.
3. Visit `http://localhost:3000`; `/healthz` checks the process and `/readyz` checks PostgreSQL.

For Coolify, build from the repo `Dockerfile` and set runtime variables as Coolify secrets. Production reuses the existing `mkety-postgres` service and logical `mkety` database through `MKETY_DATABASE_URL`; set `CAMPAIGNS_DB_SCHEMA=campaigns` so all Campaigns tables and migration history stay in that schema. The database role must be able to create that schema on first startup. The container applies pending PostgreSQL migrations before it starts listening. Never point Campaigns at `public` or create a separate PostgreSQL service for it. Do not add production credentials to this repository.

The production hostname is `campaign.mkety.com` on Coolify at the OCI VM. The app is deployed and currently reports healthy; public `/healthz` and database-backed `/readyz` checks pass, and the origin certificate validates for this hostname. DNS resolves to `89.168.70.209`. Coolify reports the source commit as `HEAD`, so the exact deployed SHA remains unconfirmed; see the current status report for the latest evidence and remaining pilot gates. The `Configure Campaigns Coolify domain` workflow finds the unique Coolify app for this repo's `main` branch, adds `https://campaign.mkety.com` without removing existing domains, sets `BETTER_AUTH_URL` to that origin, and requests a redeploy. It accepts Coolify secrets named `OCI_COOLIFY_URL`/`OCI_COOLIFY_TOKEN` or `COOLIFY_URL`/`COOLIFY_TOKEN` (the URL defaults to `https://deploy.mkety.com`). The workflow does not change DNS. Coolify/PostgreSQL is the active deployment; Workers/D1 remains an optional future target.

Set `BETTER_AUTH_SECRET` to a random secret of at least 32 characters and `BETTER_AUTH_URL` to the app's HTTPS origin for customer sign-in. Campaigns Ops uses the MKETY Auth OIDC provider with PKCE and an application-local session; it does not use the customer password login. Configure `MKETY_OPS_AUTH_ISSUER`, `MKETY_OPS_AUTH_CLIENT_ID`, `MKETY_OPS_ALLOWED_EMAIL`, and `MKETY_OPS_AUTH_CALLBACK_URL` in Coolify. Register the exact callback URI `https://campaign.mkety.com/api/ops/auth/callback` on a Campaigns-specific public OIDC client and restrict its redirect and post-logout URLs to the Campaigns hostname. The production container runs migrations before the first login. See [Email provider credential setup](docs/email-provider-credentials.md) before adding ACS or OCI email credentials.

For a future Workers/D1 deployment, copy `wrangler.jsonc.example` to `wrangler.jsonc`, create the D1 database and R2 bucket, then fill in the generated D1 database ID. The Workers target shares the Hono routes and accesses D1/R2 through native bindings.

### Read-only release configuration preflight

Before a Coolify production release, run `npm run release:preflight` in a trusted environment. It checks that `DATABASE_URL` targets the shared `mkety` database and `CAMPAIGNS_DB_SCHEMA=campaigns`, `BETTER_AUTH_URL` is the expected HTTPS origin (default `https://campaign.mkety.com`), the auth secret meets basic length checks, recipient caps are valid, and campaign sending, test sends, SMS, and OCI backup are explicitly disabled.

This checks local configuration shape only. It does not verify database ownership, migrations, DNS/TLS, deployment, backup restore, or provider status. Never import customer lists or enable sends based solely on a passing preflight.

### Storage rules
- Use tenant-prefixed opaque object keys; never put email addresses or other customer identifiers in keys.
- Keep R2 as the active source. When a durable archive/backup job is added, it must copy to OCI Infrequent Access and Azure Blob, retry idempotently, and record status in `object_archive_manifest`.
- Keep the OCI bucket private and at its Standard default tier. OCI Infrequent Access is an object-level tier; when OCI backup is explicitly enabled, the adapter selects it for new backup objects. Keep each object for at least 31 days and account for retrieval fees. Do not configure lifecycle rules or write objects while OCI_BACKUP_ENABLED is false.
- Do not delete the R2 primary copy until the archive and backup copies have been verified and retention policy allows deletion.
- Keep imported contact data, consent evidence, and suppressions in the database; object storage is for staged uploads, exports, and approved campaign assets.

See [Storage credential setup](docs/storage-credentials.md) for the exact values and console locations. OCI and Azure variables are optional; the app starts with R2 only.

## Inviolable boundaries
- Independent repository, deployments, database, queues, domains, secrets and sender reputations. **Do not modify mksaas / MKETY Mail / Assist / Trading / MkLMS**.
- Access: MKETY Ops administrators and **one authorized enterprise business seat** per approved tenant. No team invitations, child accounts or team-management screens. Transfer seat with secure account re-assignment/MFA reset; no shared passwords.
- MKETY Ops may operate campaigns for a tenant; the tenant may self-serve its own authorized marketing. Tenant isolation is enforced server-side on every read/write/event/webhook.
- Campaign sending stays off by default. Before enabling the gate, verify domain ownership/DNS, sender readiness, documented permission, and the test recipient. The independent ACS sender-test action sends only one fixed message to the signed-in account email.

## Channels & delivery-provider configuration
- Email: ACS and OCI Email Delivery adapters are selectable with `EMAIL_PROVIDER=acs-email` or `EMAIL_PROVIDER=oci-email-delivery`. Portal domain/sender onboarding, server-resolved From addresses, owner-only test-send, approved-campaign queueing, consent/suppression checks, one-click unsubscribe, and provider-routed single-job workers support both. OCI and ACS credentials stay on the server and are never exposed to tenants.
- Portal hostname: `campaign.mkety.com` is the app URL; it does not restrict the From address. `info@mkety.com` can be used after the root domain is verified and authenticated at the selected provider. Since MKETY Mail already uses the root domain, review its DNS first, preserve its MX records, and merge any provider authorization into existing SPF/DKIM/DMARC setup. A dedicated marketing subdomain offers better reputation isolation.
- SMS: implement provider-neutral SMS support and select adapters by target-country cost, sender eligibility, and registration requirements. ACS SMS is not used in the initial provider lineup. SMS remains off until the provider, sender, consent, country checks, and spending limits are approved.
- Never silently retry an uncertain delivery through a second provider. Current uncertain outcomes stop for operator review; idempotency does not imply a provider can guarantee exactly-once mailbox delivery.
- Inbound emails and mailboxes are **out of scope**: existing MKETY Mail continues untouched.
- ACS retirement planning: feature/provider-independent data schema and adapters; export or move to OCI Email Delivery by admin decision before ACS Email retirement. Confirm vendor onboarding/deadlines with Microsoft.

## Features
1. MKETY Ops approval, managed sending and optional tenant self-service; one business seat, MFA and session revocation.
2. Per-tenant domain ownership verification, sender identities, SPF/DKIM/DMARC guidance, and provider authorization. Customers use their own From domains through the platform's provider account; provider secrets are never exposed to tenants. Use marketing subdomains where possible, and do not change business MX or ordinary inbox routing.
3. CSV import; schema validation, normalization/deduplication, tags/segments, data minimization, explicit opt-in proof and unsubscribe provenance.
4. Template editor, plain-text alternatives, preview/test send, branded link and unsubscribe footer, campaign drafts, approval, schedules and controlled queue dispatch.
5. Per-tenant caps and billing/usage, rate limiting, provider quotas, automated bounce/complaint/opt-out suppression, one-click unsubscribe, exclusion before every dispatch.
6. Tracking only where permitted: accepted, sent, delivered, failed, bounced, complained; clicks/opens optional and clearly qualified.
7. Credential scoping, webhook signature checks, audit trails, retention/deletion policy, backups, restore tests, export of campaign/customer/suppression data.
8. SMS uses documented consent specifically for SMS, STOP/opt-out processing and sender registration. No unapproved country/campaign routing.

## Target architecture
Standalone UI + authenticated API + isolated database + durable job queue + worker + events processor.
Modules: tenants, single business access seat, contacts, consent, domains, templates, campaigns, delivery_attempts, provider_profiles, suppression, events, quotas/billing, audit.
Provider contract: validateConfig, verifyDomain, getCapabilities, send, resolveDeliveryStatus, normalizeEvent, enforceSuppression. The email adapter is selected by the deployment environment; SMS and OCI Object Storage backup stay disabled. State transitions are idempotent and replay-safe.

## Phases / acceptance gates
0. Verify Azure sponsorship, ACS resource linkage, email domain support, SMS country/number eligibility, provider quotas, subscription limitations, and independent hosting plan. No customer uploads.
1. Complete standalone foundation, CI/test environment, authentication/MFA, tenant-bound authorization, and no integrations to existing MKETY production. The app shell, migrations, invite-only auth, TOTP gate, and provider interfaces are in place; database-level RLS, full admin onboarding, and customer-data endpoints are not.
2. ACS and OCI domain/sender onboarding, the consent-aware email queue, and provider-routed worker are implemented behind `EMAIL_CAMPAIGN_SEND_ENABLED=false`. Run a one-recipient test with an opted-in test contact; provider event reconciliation remains future work.
3. Build domain onboarding, consent-aware CSV imports, suppression, templates, campaigns, operator review, scheduling, quotas and audit logs.
4. Build provider-neutral SMS onboarding, opt-in/opt-out, compliance tests and per-country fail-closed gates. ACS SMS is not part of the initial provider lineup.
5. Closed pilot: MKETY test domain, permission-based contacts, small batches; production smoke tests and rollback.
6. Invite a few enterprises, monitor quotas/costs/deliverability, do recovery test, establish ACS offboarding and OCI enablement procedure.

## Exclusions
No mailbox hosting or reply inbox, no general CRM, no team/employee invitation tree, no changes to MKETY Mail, no automated marketing to imported lists without evidence of permission.

## Operational notes
Existing Azure resources reported by owner: Email Communication Services and Communication Services resources. OCI Email Delivery domain setup requires the app's scoped Email Delivery IAM permissions and DNS authorization. Never commit credentials or expose them in logs. Keep provider credentials in Coolify runtime secrets. Ordinary CI uses mocked provider calls and never sends email. ACS portal-managed domain creation requires the separately scoped Entra identity. OCI domain setup creates DNS instructions in the portal and activates senders only after SPF and DKIM verify.
