# MKETY Campaigns — Standalone Architecture & Roadmap

Status: FOUNDATION IN PROGRESS (no deployment or live sending). Owner: MKETY Ops. Updated: 2026-10-20.

## Current build
- One TypeScript/Hono application with shared routes and separate Node and Cloudflare Workers entry points.
- Coolify on the OCI VM is the first deployment target. It uses PostgreSQL through `DATABASE_URL`; this repo does not provision or change an existing database.
- Optional Cloudflare Workers deployment uses D1 through a binding. D1 is not used by the Coolify deployment.
- R2 is the primary object store. OCI Object Storage (Infrequent Access) and Azure Blob Storage are configured as secondary archive/backup targets. Normal request handling writes to R2 only; explicit background replication reports each target separately for safe retries.
- Initial migrations define tenant seats, consent, contacts, suppression, campaigns, idempotent jobs, delivery attempts, archive manifests, and audit records.
- The current UI and health endpoints are a foundation only. Authentication/MFA, authorization enforcement, provider adapters, durable job processing, and the campaign workflows remain to be built before any customer data is used.

### Run locally
1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a dedicated development PostgreSQL database.
2. Run `npm ci`, then `npm run db:migrate:pg`, then `npm run dev`.
3. Visit `http://localhost:3000`; `/healthz` checks the process and `/readyz` checks PostgreSQL.

For Coolify, build from the repo `Dockerfile`, set the same runtime variables as Coolify secrets, attach the existing PostgreSQL service/network, and run `npm run db:migrate:pg` once as a controlled release step before routing traffic. Do not add production credentials to this repository.

For a future Workers/D1 deployment, copy `wrangler.jsonc.example` to `wrangler.jsonc`, create the D1 database and R2 bucket, then fill in the generated D1 database ID. The Workers target shares the Hono routes and accesses D1/R2 through native bindings.

### Storage rules
- Use tenant-prefixed opaque object keys; never put email addresses or other customer identifiers in keys.
- Keep R2 as the active source. Archive/backup copies go to OCI Infrequent Access and Azure Blob from an explicit background job; retries must be idempotent and recorded in `object_archive_manifest`.
- Configure the OCI bucket with its default tier set to Infrequent Access. OCI chooses that bucket tier independently of the R2 setting.
- Do not delete the R2 primary copy until the archive and backup copies have been verified and retention policy allows deletion.
- Keep imported contact data, consent evidence, and suppressions in the database; object storage is for staged uploads, exports, and approved campaign assets.

## Inviolable boundaries
- Independent repository, deployments, database, queues, domains, secrets and sender reputations. **Do not modify mksaas / MKETY Mail / Assist / Trading / MkLMS**.
- Access: MKETY Ops administrators and **one authorized enterprise business seat** per approved tenant. No team invitations, child accounts or team-management screens. Transfer seat with secure account re-assignment/MFA reset; no shared passwords.
- MKETY Ops may operate campaigns for a tenant; the tenant may self-serve its own authorized marketing. Tenant isolation is enforced server-side on every read/write/event/webhook.
- No live sending or customer-data migration until explicit signoff and successful compliance/domain/sender checks.

## Channels & delivery-provider configuration
- Email: Azure Communication Services (ACS) Email adapter supported and initial candidate; OCI Email Delivery adapter implemented **from day one** and disabled by default. Admin must enter credentials, validate sender/domain, test, and explicitly enable OCI at the platform or tenant level.
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
1. Complete standalone foundation, CI/test environment, authentication/MFA, tenant-bound RLS/authorization, and no integrations to existing MKETY production. Current branch has started the app shell, migrations, and runtime/storage interfaces; this gate is not yet complete.
2. Build ACS Email and OCI Email Delivery adapters (OCI disabled), test delivery, idempotency and event mapping in sandbox.
3. Build domain onboarding, consent-aware CSV imports, suppression, templates, campaigns, operator review, scheduling, quotas and audit logs.
4. Build conditional ACS SMS sender onboarding, opt-in/opt-out, compliance tests and per-country fail-closed gates.
5. Closed pilot: MKETY test domain, permission-based contacts, small batches; production smoke tests and rollback.
6. Invite a few enterprises, monitor quotas/costs/deliverability, do recovery test, establish ACS offboarding and OCI enablement procedure.

## Exclusions
No mailbox hosting or reply inbox, no general CRM, no team/employee invitation tree, no changes to MKETY Mail, no automated marketing to imported lists without evidence of permission.

## Operational notes
Existing Azure resources reported by owner: separate Email Communication Services and Communication Services resources, provisioning not inspected by this repo. Existing OCI Email Delivery requires separate sender-domain authorization. No credentials should ever enter GitHub. Document exact DNS entries only after resources and verified domain selection. 
