# Mkety Campaigns Platform Design

Date: 2026-10-29
Status: Proposed implementation design, based on the owner-approved standalone roadmap and phased MVP.

## Intent

Build Mkety Campaigns as an independent campaign portal at campaign.mkety.com. It runs first on Coolify in the OCI VM and the existing Mkety PostgreSQL database. It must be simple to operate, keep every tenant isolated, and leave a practical route to Cloudflare Workers and D1 without using D1 in the first deployment.

The system sends permission-based email campaigns and, after sender and country eligibility checks, SMS. It uses provider adapters so Azure Communication Services and OCI Email Delivery can be configured and switched independently. R2 is primary object storage; Azure Blob and OCI Object Storage are optional backup targets.

## Goals

- Deploy and operate independently of MkSaaS, Mkety Mail, Assist, Trading, and MkLMS.
- Provide Mkety Ops administration and one authorized business seat per approved tenant. No invitations or child accounts; transfers are operator-controlled and require MFA reset.
- Enforce tenant ownership on every request, query, job, webhook, and export.
- Support consent records, contact imports, tags/segments, templates, approval, scheduling, unsubscribe and suppression, delivery events, audit history, rate limits, budget guards, and emergency stop.
- Support Azure Communication Services Email first; keep OCI Email Delivery implemented but disabled until an Ops administrator validates and enables it. Keep ACS SMS gated on provisioned sender resources, country rules, and consent.
- Store operational objects in R2 and support optional encrypted backups to Azure Blob and OCI Object Storage.
- Keep application routes and domain logic compatible with Web Standards, and maintain a D1-compatible database path without deploying D1 initially.
- Do not send live campaigns or import customer lists until compliance, sender/domain checks, and explicit owner signoff are complete.

## Non-goals

- Mailboxes, inbound email, reply handling, or changes to Mkety Mail.
- General CRM, team/employee seat trees, or unapproved marketing to imported lists.
- Cloudflare as the initial production host or D1 as the initial database.
- Automatic failover that retries an uncertain delivery through another provider.

## Approaches considered

1. **Phased vertical slice (selected):** establish the standalone app, tenant-safe access, provider settings, domain/sender readiness, consent-aware email campaigns, and a durable delivery queue; then add SMS, operational hardening, OCI backup, and later Cloudflare/D1 deployment. This gives a working product early while preserving the roadmap and lets sending safety be tested before adding channels.
2. **Build the entire roadmap in one release:** implement email, SMS, domain automation, imports, quota/billing, all event types, and all backup targets together. This delays a usable result and combines multiple provider and compliance risks.
3. **Infrastructure-first:** finish OCI Object Storage and every optional provider resource before application work. This does not fit the current state: ACS, OCI Email, Azure Blob, R2, Coolify, and PostgreSQL are ready enough to begin, and OCI backup remains optional.

The owner selected the phased approach and asked to deliver the full roadmap in stages.

## Architecture and implementation choices

- **Application:** TypeScript with Hono. Use Hono's Web Standards-based request/response core, server-rendered HTML for the initial admin portal, and distinct Node and Cloudflare entry points. Coolify runs the Node entry point. Keep Worker-only bindings outside domain logic.
- **Persistence:** use a dedicated Campaigns database on the existing Coolify PostgreSQL server; never point Campaigns migrations at a database shared with another Mkety application. Drizzle ORM with PostgreSQL migrations for the first deployment and a SQLite/D1 schema and migration path maintained alongside it. Keep dialect-specific database setup behind a small database factory and verify shared repository behavior against both dialects before considering D1 production. Before applying migrations, verify that MKETY_DATABASE_URL names the dedicated Campaigns database without displaying its credential.
- **Authentication and onboarding:** use a maintained authentication library with database-backed sessions and TOTP MFA. Require MFA for Ops administrators and tenant owners. During the closed pilot, Mkety Ops manually creates each approved tenant and its single business seat; the tenant can then sign in and manage its own domains and campaigns. Public self-signup remains off. Use server-side tenant membership checks; never trust a tenant ID supplied by the browser as authorization.
- **Jobs:** use a database-backed outbox/queue and a separate worker process in the same Coolify deployment. Claim work with leases and idempotency keys. A provider timeout with uncertain outcome must be reconciled or shown for operator review, not automatically sent through a second provider.
- **Providers:** Mkety manages provider credentials centrally in the initial release; tenants configure authorized domains and sender identities, not their own ACS/OCI credentials. Keep a future tenant-owned provider profile possible through the adapter boundary. Define channel-specific interfaces for configuration validation, domain/sender verification, capabilities, sending, delivery-status resolution, and event normalization. Keep Azure Email, Azure SMS, and OCI Email as separate adapters with explicit enabled state and health status. The initial ACS connection string supports data-plane sending; it does not grant Azure Resource Manager rights to create or link email domains. Automated Azure domain provisioning therefore requires a separately scoped management identity before that part is enabled.
- **Email onboarding:** portal-managed domain records, DNS instructions, verification state, sender identities, and test-send action. Do not change customer MX records. Keep domain creation and verification fail-closed until provider confirms eligibility.
- **Storage:** R2 remains primary. Azure Blob backup uses the configured private container. OCI backup uses a private S3-compatible bucket and customer secret key. Uploads are opt-in, use immutable timestamped object names, and do not block campaign delivery if an optional backup target fails. For OCI Infrequent Access, use the S3 Standard-IA storage class per object and retain each object for at least 31 days; do not overwrite a single backup key daily. Do not upload anything to OCI until backup jobs are enabled.
- **Secrets:** never put secret values in source, logs, or commits. Continue the approved encrypted GitHub Actions-to-Coolify deployment flow; the workflow should transfer values only to Coolify runtime environment variables. Update the current README statement that says credentials must never enter GitHub so it clearly prohibits committed credentials while documenting the approved encrypted-secret transport.
- **Deployment:** Docker image for Coolify, health/readiness endpoints, migration job, application process, and worker process. Start with the existing PostgreSQL and domain campaign.mkety.com. No cross-repository protocol or shared runtime dependency.

## Initial delivery stages

1. **Foundation:** project scaffold, environment validation, secure session/MFA, tenant and single-seat authorization, PostgreSQL migrations, health checks, CI, Coolify container setup, and D1 compatibility contract tests.
2. **Email pilot:** provider settings and health checks; domain onboarding and DNS records; contact import with opt-in evidence; tags/segments; templates and plain-text alternative; preview/test send; campaign draft/review/schedule; queue dispatch; delivery events; bounce/complaint/unsubscribe suppression; audit log, rate limits, budget guard, and emergency stop. OCI Email remains disabled by default.
3. **SMS and backup:** ACS SMS gated on number/sender availability and country compliance; Azure Blob backup test; OCI backup adapter and a private bucket once its credentials are provisioned; restore and export checks.
4. **Cloudflare readiness:** verify Worker entry point and D1 migration/contract tests while keeping Coolify/PostgreSQL production. A cutover requires a separate owner decision after parity and restore validation.

## Current readiness and dependencies

Already available in the repository secrets: Coolify URL/token, PostgreSQL URL, Cloudflare R2 credentials, ACS connection string, Azure Blob connection string/container, and OCI Email endpoint, region, tenancy, compartment, user, API signing fingerprint/private key, and policy OCID.

Still required before production campaign sending: a verified/linked sender domain, explicit provider test and approval, and the Azure management identity if domain creation/linking must be fully self-serve through the portal. SMS also requires an eligible provisioned sender and country approval.

Still optional before the email pilot: OCI Object Storage bucket and S3 customer secret key. An empty bucket has no stored-data capacity charge, while requests may be metered. Infrequent Access data has a 31-day minimum retention and retrieval fees. OCI backup remains disabled until configured and tested.

The GitHub repository currently contains only its roadmap README; this design does not claim the application is already implemented or deployed.
