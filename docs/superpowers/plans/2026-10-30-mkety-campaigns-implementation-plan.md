# Mkety Campaigns Implementation Plan

Date: 2026-10-30
Design: [Platform design](../specs/2026-10-29-mkety-campaigns-platform-design.md)

## Delivery order

### 1. Project foundation
- Scaffold TypeScript/Hono with Node and Cloudflare Worker entries.
- Add strict environment parsing, health checks, Docker image, Coolify start commands, CI and lint/typecheck/test scripts.
- Define provider, object storage, database and job ports before concrete adapters.
- Add Postgres migrations and separate SQLite/D1 migrations; contract tests cover shared repository behavior.
- Keep production sending and OCI backups disabled by default.

### 2. Identity and tenant boundary
- Add Ops-managed tenant/seat provisioning, login, TOTP MFA and database sessions.
- Enforce tenant ownership through shared authorization helpers on pages, mutations, jobs, webhooks, exports and object keys.
- Add audit events and tenant-isolation tests before adding campaign features.

### 3. Provider setup and domains
- Implement Azure Email and OCI Email adapters with explicit readiness and enabled flags.
- Implement Azure Resource Manager domain create/link/verification using the dedicated, resource-scoped identity. Never enable send until DNS and provider checks pass.
- Build sender identity, DNS instructions, verification state and safe test-send UI.
- Keep OCI Email disabled until Ops validates and enables it.

### 4. Email campaign vertical slice
- Add contacts with consent provenance, CSV preview/import, tags/segments, templates and plain-text alternative.
- Build draft/review/schedule, recipient revalidation, quotas, budget guard, emergency stop and DB outbox worker.
- Add idempotent dispatch, delivery-event normalization, unsubscribe, bounce/complaint suppression and audit trail.
- Test uncertain provider timeouts without automatic cross-provider retry.

### 5. SMS adapter and activation
- Implement channel-neutral SMS interfaces and normalized send/status/webhook events.
- Implement an adapter after destination markets and registration needs are reviewed; shortlist Telnyx for transparent usage pricing.
- Do not implement ACS SMS in the initial provider lineup.
- Require explicit provider activation, sender eligibility, country compliance, consent, per-tenant quotas and spend caps before any live SMS.

### 6. Backups
- Keep R2 as primary object storage and test Azure Blob backup/restore.
- Implement OCI S3-compatible backup behind OCI_BACKUP_ENABLED=false by default.
- Support immutable keys, object-level tier choice and restore tests. Never use OCI Infrequent Access without 31-day retention and retrieval-cost guardrails.
- Provisioning the empty OCI bucket must not trigger object writes or enable the integration.

### 7. Cloudflare and D1 readiness
- Run Worker compatibility checks and SQLite/D1 migration/contract tests in CI.
- Keep production on Coolify/PostgreSQL; document parity gaps and require a separate owner decision before cutover.

## Release gates
- No production campaign send until provider/domain tests and explicit owner signoff.
- No SMS send until destination pricing, sender, registration, consent and usage caps are reviewed.
- No OCI backup writes while the feature flag is off.
- No production deployment until dedicated Campaigns database name and Coolify runtime variables are verified without exposing secrets.
