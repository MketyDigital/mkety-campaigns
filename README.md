# MKETY Campaigns — Standalone Architecture & Roadmap

Status: PLAN ONLY (no deployed application). Owner: MKETY Ops. Date: 2026-10-15.

## Inviolable boundaries
- Independent repository, deployments, database, queues, domains, secrets and sender reputations. **Do not modify mksaas / MKETY Mail / Assist / Trading / MkLMS**.
- Access: MKETY Ops administrators and **one authorized enterprise business seat** per approved tenant. No team invitations, child accounts or team-management screens. Transfer seat with secure account re-assignment/MFA reset; no shared passwords.
- MKETY Ops may operate campaigns for a tenant; the tenant may self-serve its own authorized marketing. Tenant isolation is enforced server-side on every read/write/event/webhook.
- No live sending or customer-data migration until explicit signoff and successful compliance/domain/sender checks.

## Channels & delivery-provider configuration
- Email: Azure Communication Services (ACS) Email is the initial adapter; OCI Email Delivery is implemented as an optional adapter and disabled by default. Mkety centrally manages provider credentials. Tenants authorize their domains and senders in the portal, then complete verification and test steps before sending.
- SMS: use a provider-neutral SMS adapter and select providers by destination-country pricing, sender availability, registration, and approval. ACS SMS is not part of the initial lineup. SMS remains disabled until a provider, eligible sender, country rules, and consent are approved.
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

## Architecture
Standalone UI + authenticated API + isolated database + durable job queue + worker + events processor.
Modules: tenants, single business access seat, contacts, consent, domains, templates, campaigns, delivery_attempts, provider_profiles, suppression, events, quotas/billing, audit.
Provider contract: validateConfig, verifyDomain, getCapabilities, send, resolveDeliveryStatus, normalizeEvent, enforceSuppression. OCI Email adapter disabled until Ops enables; SMS adapters are provider-independent and must not assume ACS. State machine must be idempotent and replay-safe.

## Phases / acceptance gates
0. Verify Azure sponsorship, ACS resource linkage, email domain support, SMS country/number eligibility, provider quotas, subscription limitations, and independent hosting plan. No customer uploads.
1. Initialize standalone codebase/CI with test environment, database migrations, MFA, tenant-bound RLS/authorization and no integrations to existing MKETY production.
2. Build ACS Email and OCI Email Delivery adapters (OCI disabled), test delivery, idempotency and event mapping in sandbox.
3. Build domain onboarding, consent-aware CSV imports, suppression, templates, campaigns, operator review, scheduling, quotas and audit logs.
4. Build provider-neutral SMS onboarding, opt-in/opt-out, compliance tests and per-country fail-closed gates; do not use ACS SMS initially.
5. Closed pilot: MKETY test domain, permission-based contacts, small batches; production smoke tests and rollback.
6. Invite a few enterprises, monitor quotas/costs/deliverability, do recovery test, establish ACS offboarding and OCI enablement procedure.

## Exclusions
No mailbox hosting or reply inbox, no general CRM, no team/employee invitation tree, no changes to MKETY Mail, no automated marketing to imported lists without evidence of permission.

## Operational notes
Existing Azure resources reported by owner: Email Communication Services and Communication Services resources. Existing OCI Email Delivery requires sender-domain authorization. Never commit credentials or print them in CI logs. The approved encrypted GitHub repository secrets may transport credentials to Coolify runtime environment variables through the deployment workflow. Azure portal-managed domain creation requires a separate resource-scoped Azure Resource Manager identity. Document DNS records only after a provider creates the domain. 
