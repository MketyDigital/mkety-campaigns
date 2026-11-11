# MKETY Campaigns: implementation status, roadmap, and pilot gates

**Audit date:** 2026-11-11. **Status:** development / closed-pilot preparation; production deployment and live sending are not verified.

This page describes code on main separately from live operational evidence. Passing CI or merging code proves neither successful deployment nor safe live delivery. The 2026-10-29 design and 2026-10-30 implementation plan remain historical intent.

## Implemented on main

| Area | Current state |
| --- | --- |
| Runtime | TypeScript/Hono app with Node and Cloudflare Worker entry points, Docker, PostgreSQL and D1 migrations, and CI. Coolify/PostgreSQL remains the intended first target. |
| Authentication and tenant access | Invite-only Better Auth, password login, TOTP MFA and backup codes, single business seat, tenant-scoped APIs, MFA-protected Ops access. Full production security certification is not established. |
| Providers and domains | ACS and OCI Email Delivery adapters; domain, DNS-verification and sender-readiness workflows. Real credentials, permissions, provider quotas and DNS ownership are unverified. |
| Contacts and consent | Manual/CSV import, consent evidence, withdrawal, suppression and unsubscribe tokens. Tags, segments and export/retention workflows are incomplete. |
| Campaigns | Draft, review, Ops approval, scheduling, explicit queue action and durable per-recipient jobs. Consent and suppression are checked before dispatch. Sending remains disabled unless explicitly enabled. |
| Sending safeguards | Security headers, no-store on protected/auth pages, fail-closed HTTPS unsubscribe validation, per-campaign recipient caps, and an atomic per-tenant daily queue budget (default 1,000 queued recipients per UTC day). The daily budget is not a provider rate limiter or billing control. |
| Delivery events | Canonical ACS/OCI event contract, idempotent reconciliation and permanent bounce/complaint suppression. **No provider-authenticated public ingestion route or provider subscription verification exists.** Do not connect public requests directly to the reconciler. |
| Storage and recovery | R2, Azure Blob and OCI object-storage adapters exist. No automated PostgreSQL backup and tested restore pipeline is established. |
| SMS | Provider interface and Telnyx adapter exist; live SMS remains disabled and compliance/STOP handling is incomplete. |
| Deployment | Coolify configuration and a domain workflow exist, but the live app, database, migrations, DNS/TLS and deployment SHA are unverified. |

## Production evidence checked

The latest observed main-branch CI runs after the safety and reconciliation merges completed successfully. CI covers typecheck, build, PostgreSQL migrations/auth schema and automated tests; it does not inspect Coolify runtime state or provider accounts.

The existing Coolify domain workflow was inspected through its latest recorded run. It returned 13 applications, found **zero** matching MketyDigital/mkety-campaigns on main, and exited before making changes. This is evidence that this workflow did not configure a deployment; it does not establish whether an app was created through another path. DNS/TLS, database ownership, deployed commit, runtime secrets, migration state, health and restore readiness remain unverified.

## P0 gates before a live campaign

- [ ] Provision or identify exactly one Coolify application for this repository on main; verify its build and runtime settings.
- [ ] Confirm the dedicated PostgreSQL database is mkety_campaigns; review and apply migrations through a controlled, rollback-aware release.
- [ ] Configure runtime secrets in Coolify, bootstrap the first Ops account, verify MFA, and confirm the send/test/SMS gates are explicitly off.
- [ ] Verify DNS and TLS for campaign.mkety.com, then check /healthz, /readyz, authenticated access, tenant isolation and worker behavior on the deployed SHA.
- [ ] Implement and test authenticated ACS and OCI event ingestion, payload normalization, replay defense and provider subscription verification before exposing any event endpoint.
- [ ] Add a global emergency stop, provider-specific rate limits, monitoring and operator alerts. A polling interval and daily queue cap do not constrain provider sends per second.
- [ ] Configure encrypted PostgreSQL backups, retention and monitoring; restore one into an isolated database and record recovery evidence.
- [ ] Verify provider credentials, sending quotas, owned SPF/DKIM/DMARC, approved sender identity and delivery/opt-out behavior.
- [ ] Keep EMAIL_CAMPAIGN_SEND_ENABLED=false until all gates pass. A one-recipient pilot requires a separately approved operator action after deployment verification.

## P1 customer and operating features

- [ ] Template editor, safe HTML/text preview and segmentation with campaign exclusions.
- [ ] Delivery reports for accepted, delivered, failed, bounced and complained outcomes.
- [ ] Tenant usage/cost controls, provider quotas, dashboards and operator alerts.
- [ ] Data export, privacy retention/deletion, and object-asset lifecycle.
- [ ] End-to-end provider tests, rollback rehearsal and deliverability monitoring.

## P2, separately gated

- [ ] SMS country/sender registration, lawful consent, STOP processing, pricing limits and authenticated provider events.
- [ ] Cloudflare Workers/D1 deployment and recovery parity; no automatic cutover.
- [ ] OCI object backup activation only after IAM, retention, cost and restore checks.

## Release checklist

1. Record the reviewed main SHA and successful CI result.
2. Verify the Coolify application, dedicated database, runtime secrets, migration ledger, and HTTPS domain.
3. Confirm Ops MFA, tenant boundaries, worker state, send gates off, provider state and recovery evidence.
4. Run deployed health/readiness and authenticated smoke checks.
5. Only after all gates pass, separately approve a one-recipient test with a consented owned mailbox, verified sender, event reconciliation and unsubscribe verification; disable the send gate afterward.
6. Record deployment SHA, test evidence, backup-restore result, operator signoff and rollback decision.

## Documentation

- [Architecture and product roadmap](../../README.md)
- [Original platform design (historical)](../superpowers/specs/2026-10-29-mkety-campaigns-platform-design.md)
- [Original implementation plan (historical)](../superpowers/plans/2026-10-30-mkety-campaigns-implementation-plan.md)
- [Email provider setup](../email-provider-credentials.md)
- [Storage and backup guidance](../storage-credentials.md)
- [Provider provisioning](provider-provisioning.md)
- [CI workflow](../../.github/workflows/ci.yml)
- [Coolify domain workflow](../../.github/workflows/coolify-domain.yml)

Repository evidence cannot confirm production health, deployed SHA, actual database ownership, DNS/TLS, provider approval, live delivery, consent quality or restore success. Treat all as unverified until observed in the target environment.
