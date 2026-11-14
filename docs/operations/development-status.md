# MKETY Campaigns: implementation status, roadmap, and pilot gates

**Audit date:** 2026-11-14. **Status:** production app is deployed and healthy on Coolify. The database-backed `/readyz` check, public routes, DNS A record, and origin TLS certificate are verified. Campaign/test sending, SMS, and OCI backup remain disabled; this is not cleared for a live campaign.

This page describes code on main separately from live operational evidence. Passing CI or merging code proves neither successful deployment nor safe live delivery. The 2026-10-29 design and 2026-10-30 implementation plan remain historical intent.

## Implemented on main

| Area | Current state |
| --- | --- |
| Runtime | TypeScript/Hono app with Node and Cloudflare Worker entry points, Docker, PostgreSQL and D1 migrations, and CI. Coolify/PostgreSQL remains the intended first target. |
| Authentication and tenant access | Invite-only Better Auth, password login, TOTP MFA and backup codes, single business seat, and tenant-scoped APIs. Tenant MFA is enforced in the app. Ops sign-in uses a custom MKETY OIDC flow with an allowlisted, verified email; the callback does not verify an MFA assurance claim, so Ops MFA enforcement must be confirmed in Zitadel before access is treated as MFA-protected. Full production security certification is not established. |
| Providers and domains | ACS and OCI Email Delivery adapters; domain, DNS-verification and sender-readiness workflows. Real credentials, permissions, provider quotas and DNS ownership are unverified. |
| Contacts and consent | Manual/CSV import, consent evidence, withdrawal, suppression and unsubscribe tokens. Tags, segments and export/retention workflows are incomplete. |
| Campaigns | Draft, review, Ops approval, scheduling, explicit queue action and durable per-recipient jobs. Consent and suppression are checked before dispatch. Sending remains disabled unless explicitly enabled. |
| Sending safeguards | Security headers, no-store on protected/auth pages, fail-closed HTTPS unsubscribe validation, per-campaign recipient caps, a persisted email emergency stop checked before queue/worker dispatch, a database-backed per-provider minimum-interval throttle (`EMAIL_PROVIDER_MIN_INTERVAL_MS`, default 1 second; 250 ms–60 seconds), and an atomic per-tenant daily queue budget (default 1,000 queued recipients per UTC day). The interval and daily budget do not enforce vendor quotas, billing limits, or monitoring. |
| Delivery events | Canonical ACS/OCI event contract, idempotent reconciliation and permanent bounce/complaint suppression. **No provider-authenticated public ingestion route or provider subscription verification exists.** Do not connect public requests directly to the reconciler. |
| Storage and recovery | R2, Azure Blob and OCI object-storage adapters exist. No automated PostgreSQL backup and tested restore pipeline is established. |
| SMS | Provider interface and Telnyx adapter exist; live SMS remains disabled and compliance/STOP handling is incomplete. |
| Deployment | The production app is deployed in the existing Mkety Core production environment on the shared `mkety-postgres` service, using schema `campaigns`. Coolify reports `running:healthy`, and the public `/readyz` route and HTTPS certificate are verified. Campaign sends, test sends, SMS, and OCI backup remain disabled. |

## Production evidence checked

The latest post-deploy verification (2026-11-14, workflow run 45) reports the Coolify app as `running:healthy`. Coolify is configured to check the database-backed `/readyz` route over HTTP on port 3000, with a 180-second start period, 10-second interval, 5-second timeout, and six retries. Public `/healthz` returned HTTP 200 with `ok`; public `/readyz` returned HTTP 200 with `ready`. The deployment ran the app's `start:production` command, which applies PostgreSQL migrations before starting the server. Runtime readiness confirms live PostgreSQL connectivity; the migration ledger and schema isolation still need a separate review.

The health-check failure was caused by the runtime image lacking both `curl` and `wget`, which Coolify requires inside the app container to run dashboard-configured HTTP checks. The runtime Docker image now installs `curl`; the strict database-backed `/readyz` check is restored. The temporary `/healthz` platform check and certificate-bypassing diagnostic probe have been removed. Historical failed deployment records may still show the earlier health-check failure; the latest app state is healthy.

Public DNS resolves `campaign.mkety.com` to exactly one IPv4 A record, `89.168.70.209`, and no IPv6 record. Direct TLS verification now succeeds: the certificate is authorized, its subject/SAN matches `campaign.mkety.com`, and its recorded validity ends 2027-02-12. The deployed app is configured for the `main` branch, root Dockerfile, HTTPS domain, and port 3000. Coolify's app metadata reports `git_commit_sha=HEAD`, so the exact deployed source SHA is still not independently exposed by the current verifier.

The production app has 46 runtime variables. The required auth/database variable names are present, as are the complete ACS email, OCI Email Delivery, and Azure domain-management key groups. Credentials, permissions, sender/domain ownership, quotas, and provider delivery have not been live-tested. Coolify marks `DATABASE_URL` as `is_shown_once` and does not return its value via the environment API; the provisioning workflow validates its host/port/database against the existing internal `mkety-postgres` endpoint and configures logical database `mkety` with schema `campaigns`. For that exact internal endpoint, it normalizes `sslmode=require` to `sslmode=no-verify`: PostgreSQL traffic remains TLS-encrypted, but the server certificate is not validated. The successful `/readyz` response confirms the runtime can query the database; GitHub-hosted runners cannot resolve the Docker-only database hostname and cannot validate internal connectivity or grants.

Provisioning keeps email test sends, campaign sends, SMS, and OCI backup disabled. A successful app deployment does not authorize live delivery. The bootstrap Ops account and OIDC login are not verified. The app's custom Ops OIDC callback does not check an MFA assurance claim; verify Zitadel's MFA policy and the token assurance received by this app before treating Ops access as MFA-protected. Tenant isolation, emergency-stop behavior, provider-event authentication/replay handling, provider quotas, encrypted backup/restore, and sender DNS/delivery behavior also remain unverified or incomplete.

## P0 gates before a live campaign

- [x] Confirm one Coolify app is configured for this repository's `main` branch, Dockerfile build, root context, HTTPS domain, and port 3000. The API reports deployed SHA as `HEAD`; verify the exact deployed commit if release traceability is required.
- [ ] Review the `campaigns` migration ledger and schema isolation on the existing `mkety` logical database in `mkety-postgres`. The runtime `/readyz` query succeeds, but this does not replace a migration/grant review.
- [ ] Bootstrap the first Ops account and verify Zitadel/OIDC login. Confirm the Zitadel policy requires MFA for this client and that the ID token (or another validated provider signal) proves MFA; the app callback currently checks signature, issuer, audience, time, nonce and verified email, but not MFA assurance. Do not treat Ops access as MFA-protected until this is verified.
- [x] Confirm runtime email test sends, campaign sends, SMS, and OCI backup remain disabled.
- [x] Create and verify the `campaign.mkety.com` A record to `89.168.70.209`; public DNS returns one matching IPv4 record and no IPv6 record.
- [x] Verify a valid origin certificate for `campaign.mkety.com`; TLS validation succeeds and the certificate SAN matches the domain.
- [x] Diagnose and correct the Coolify health-check failure: the runtime image now includes `curl`, and Coolify's database-backed `/readyz` check is healthy.
- [x] Verify public `/healthz` returns HTTP 200 and `/readyz` returns HTTP 200/`ready`.
- [ ] Verify tenant isolation, Ops emergency-stop behavior, and worker queue behavior without enabling sends.
- [ ] Implement and test authenticated ACS and OCI event ingestion, payload normalization, replay defense, and provider subscription verification before exposing any event endpoint.
- [ ] Add monitoring, operator alerts, and provider quota/burst limits validated against account limits; the app's per-provider interval and daily queue budget do not enforce vendor quotas.
- [ ] Configure encrypted PostgreSQL backups, retention and monitoring; restore one into an isolated database and record recovery evidence.
- [ ] Verify owned sender domains, SPF/DKIM/DMARC, approved sender identity, and delivery/opt-out behavior without relaxing sends gates.
- [ ] Keep `EMAIL_CAMPAIGN_SEND_ENABLED=false` and `EMAIL_TEST_SEND_ENABLED=false` until all gates pass. A one-recipient pilot still requires a separate, explicit operator decision after verification.

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
2. Verify the Coolify application, shared `mkety` database target, `campaigns` schema, runtime secrets, migration ledger, and HTTPS domain.
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

Repository evidence alone cannot confirm production health or target-environment state. The live checks recorded above are verified; account security, provider approval, delivery, consent quality, backups, restore success, and exact deployed SHA remain open until observed in the target environment.
