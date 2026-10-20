# MKETY Campaigns — Standalone Architecture & Roadmap

Status: FOUNDATION IN PROGRESS (no deployment or live sending). Owner: MKETY Ops. Updated: 2026-10-20.

## Current build
- One TypeScript/Hono application with shared routes and separate Node and Cloudflare Workers entry points.
- Coolify on the OCI VM is the first deployment target. It uses PostgreSQL through `DATABASE_URL`; this repo does not provision or change an existing database.
- Optional Cloudflare Workers deployment uses D1 through a binding. D1 is not used by the Coolify deployment.
- R2 is the primary object store. OCI Object Storage (Infrequent Access) and Azure Blob Storage are configured as secondary archive/backup targets. Normal request handling writes to R2 only; explicit background replication reports each target separately for safe retries.
- Initial migrations define tenant seats, consent, contacts, suppression, campaigns, idempotent jobs, delivery attempts, archive manifests, and audit records.
- Better Auth now provides invite-only email/password sign-in and TOTP/backup-code MFA. Tenant routes fail closed unless the session has MFA enabled, the session was created after MFA enrollment, and the user has one active seat on an approved tenant.
- ACS Email and OCI Email Delivery HTTPS provider adapters are implemented with mocked-request signing tests. They are not exposed through a campaign send route yet; delivery queues, event reconciliation, and live provider checks remain outstanding.
- The UI, contact/consent workflows, campaign workflows, and durable job processing remain to be built before customer data is used.

### Run locally
1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a dedicated development PostgreSQL database.
2. Run `npm ci`, then `npm run db:migrate:pg`, then `npm run dev`.
3. Visit `http://localhost:3000`; `/healthz` checks the process and `/readyz` checks PostgreSQL.

For Coolify, build from the repo `Dockerfile`, set runtime variables as Coolify secrets, and point `DATABASE_URL` at a dedicated `mkety_campaigns` database on the OCI PostgreSQL service. Do not point it at another MKETY application's database or reuse its schema. Run `npm run db:migrate:pg` once as a controlled release step before routing traffic. Do not add production credentials to this repository.

Set `BETTER_AUTH_SECRET` to a random secret of at least 32 characters and `BETTER_AUTH_URL` to the app's HTTPS origin. After applying migrations, create the first Ops login once with `npm run admin:bootstrap`, supplying `BOOTSTRAP_OPS_EMAIL`, `BOOTSTRAP_OPS_NAME`, and `BOOTSTRAP_OPS_PASSWORD` only in that one-time command environment. It refuses to run after an Ops user exists. Sign in through `/api/auth/sign-in/email`, enroll and verify TOTP, then use the account for admin setup. Public sign-up is disabled. See [Email provider credential setup](docs/email-provider-credentials.md) before adding ACS or OCI email credentials.

For a future Workers/D1 deployment, copy `wrangler.jsonc.example` to `wrangler.jsonc`, create the D1 database and R2 bucket, then fill in the generated D1 database ID. The Workers target shares the Hono routes and accesses D1/R2 through native bindings.

### Storage rules
- Use tenant-prefixed opaque object keys; never put email addresses or other customer identifiers in keys.
- Keep R2 as the active source. Archive/backup copies go to OCI Infrequent Access and Azure Blob from an explicit background job; retries must be idempotent and recorded in `object_archive_manifest`.
- OCI Object Storage buckets default to Standard or Archive, not Infrequent Access. Use a Standard bucket with an Object Lifecycle Management rule to transition the backup objects to Infrequent Access; choose the age based on retention and retrieval needs. Infrequent Access has a 31-day minimum retention and retrieval fees.
- Do not delete the R2 primary copy until the archive and backup copies have been verified and retention policy allows deletion.
- Keep imported contact data, consent evidence, and suppressions in the database; object storage is for staged uploads, exports, and approved campaign assets.

See [Storage credential setup](docs/storage-credentials.md) for the exact values and console locations. OCI and Azure variables are optional; the app starts with R2 only.

## Inviolable boundaries
- Independent repository, deployments, database, queues, domains, secrets and sender reputations. **Do not modify mksaas / MKETY Mail / Assist / Trading / MkLMS**.
- Access: MKETY Ops administrators and **one authorized enterprise business seat** per approved tenant. No team invitations, child accounts or team-management screens. Transfer seat with secure account re-assignment/MFA reset; no shared passwords.
- MKETY Ops may operate campaigns for a tenant; the tenant may self-serve its own authorized marketing. Tenant isolation is enforced server-side on every read/write/event/webhook.
- No live sending or customer-data migration until explicit signoff and successful compliance/domain/sender checks.

## Channels & delivery-provider configuration
- Email: Azure Communication Services (ACS) Email and OCI Email Delivery HTTPS adapters are implemented behind a provider contract. No campaign send route calls them yet. OCI is not eligible for use until credentials, sender/domain checks, a sandbox test, operator enablement, and safety limits are in place.
- SMS: ACS SMS adapter implemented if subscription, sender type, phone-number procurement and destination-country approvals permit. SMS is *not* considered active merely because an ACS resource exists. Future SMS provider adapter remains available.
- Provider routing controlled in admin UI with explicit enabled/disabled state, country capability, tenant/domain eligibility, throughput limit, budget guardrails, circuit breaker and emergency stop. Never silently retry an uncertain delivery through a second provider: use idempotency, reconciliation and explicit operator review.
- Inbound emails and mailboxes are **out of scope**: existing MKETY Mail continues untouched.
- ACS retirement planning: feature/provider-independent data schema and adapters; export or move to OCI Email Delivery by admin decision before ACS Email retirement. Confirm vendor onboarding/deadlines with Microsoft.

## Features
1. MKETY Ops approval, managed sending and optional tenant self-service; one business seat, MFA and session revocation.
2. Independent domain verification, sender identities, SPF/DKIM/DMARC guidance. Use marketing subdomains rather than changing business MX or ordinary inbox routing.
3. CSV import; schema validation, normalization/deduplication, tags/segments, data minimization, explicit opt-in proof and unsubscribe provenance.
4. Template editor, plain-text alternatives, preview/test send, branded link and unsubscribe footer, campaign drafts, approval, schedules and controlled queue dispatch.
5. Per-tenant caps and billing/usage, rate limiting, provider quotas, automated bounce/complaint/opt-out suppression, one-click unsubscribe, exclusion before every dispatch.
6. Tracking only where permitted: accepted, sent, delivered, failed, bounced, complained; clicks/opens optional and clearly qualified.
7. Credential scoping, webhook signature checks, audit trails, retention/deletion policy, backups, restore tests, export of campaign/customer/suppression data.
8. SMS uses documented consent specifically for SMS, STOP/opt-out processing and sender registration. No unapproved country/campaign routing.

## Target architecture
Standalone UI + authenticated API + isolated database + durable job queue + worker + events processor.
Modules: tenants, single business access seat, contacts, consent, domains, templates, campaigns, delivery_attempts, provider_profiles, suppression, events, quotas/billing, audit.
Provider contract: validateConfig, verifyDomain, getCapabilities, send, resolveDeliveryStatus, normalizeEvent, enforceSuppression. OCI adapter disabled until admin enables; ACS Email/SMS separate channel capabilities. State machine must be idempotent and replay-safe.

## Phases / acceptance gates
0. Verify Azure sponsorship, ACS resource linkage, email domain support, SMS country/number eligibility, provider quotas, subscription limitations, and independent hosting plan. No customer uploads.
1. Complete standalone foundation, CI/test environment, authentication/MFA, tenant-bound authorization, and no integrations to existing MKETY production. The app shell, migrations, invite-only auth, TOTP gate, and provider interfaces are in place; database-level RLS, full admin onboarding, and customer-data endpoints are not.
2. Wire ACS Email and OCI Email Delivery adapters into a durable queue, then test delivery, idempotency and event mapping in sandbox. OCI remains disabled until explicit operator enablement.
3. Build domain onboarding, consent-aware CSV imports, suppression, templates, campaigns, operator review, scheduling, quotas and audit logs.
4. Build conditional ACS SMS sender onboarding, opt-in/opt-out, compliance tests and per-country fail-closed gates.
5. Closed pilot: MKETY test domain, permission-based contacts, small batches; production smoke tests and rollback.
6. Invite a few enterprises, monitor quotas/costs/deliverability, do recovery test, establish ACS offboarding and OCI enablement procedure.

## Exclusions
No mailbox hosting or reply inbox, no general CRM, no team/employee invitation tree, no changes to MKETY Mail, no automated marketing to imported lists without evidence of permission.

## Operational notes
Existing Azure resources reported by owner: separate Email Communication Services and Communication Services resources, provisioning not inspected by this repo. Existing OCI Email Delivery requires separate sender-domain authorization. No credentials should ever enter GitHub. Document exact DNS entries only after resources and verified domain selection. 
