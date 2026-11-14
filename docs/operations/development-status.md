# MKETY Campaigns: implementation status, roadmap, and pilot gates

**Audit date:** 2026-11-14. **Status:** closed-pilot preparation; the Campaigns DNS A record is verified, but the latest Coolify deployment failed its health check and the origin still serves Traefik's default certificate. Deployed SHA, runtime readiness, and live sending remain unverified.

This page describes code on main separately from live operational evidence. Passing CI or merging code proves neither successful deployment nor safe live delivery. The 2026-10-29 design and 2026-10-30 implementation plan remain historical intent.

## Implemented on main

| Area | Current state |
| --- | --- |
| Runtime | TypeScript/Hono app with Node and Cloudflare Worker entry points, Docker, PostgreSQL and D1 migrations, and CI. Coolify/PostgreSQL remains the intended first target. |
| Authentication and tenant access | Invite-only Better Auth, password login, TOTP MFA and backup codes, single business seat, tenant-scoped APIs, MFA-protected Ops access. Full production security certification is not established. |
| Providers and domains | ACS and OCI Email Delivery adapters; domain, DNS-verification and sender-readiness workflows. Real credentials, permissions, provider quotas and DNS ownership are unverified. |
| Contacts and consent | Manual/CSV import, consent evidence, withdrawal, suppression and unsubscribe tokens. Tags, segments and export/retention workflows are incomplete. |
| Campaigns | Draft, review, Ops approval, scheduling, explicit queue action and durable per-recipient jobs. Consent and suppression are checked before dispatch. Sending remains disabled unless explicitly enabled. |
| Sending safeguards | Security headers, no-store on protected/auth pages, fail-closed HTTPS unsubscribe validation, per-campaign recipient caps, a persisted email emergency stop checked before queue/worker dispatch, a database-backed per-provider minimum-interval throttle (`EMAIL_PROVIDER_MIN_INTERVAL_MS`, default 1 second; 250 ms–60 seconds), and an atomic per-tenant daily queue budget (default 1,000 queued recipients per UTC day). The interval and daily budget do not enforce vendor quotas, billing limits, or monitoring. |
| Delivery events | Canonical ACS/OCI event contract, idempotent reconciliation and permanent bounce/complaint suppression. **No provider-authenticated public ingestion route or provider subscription verification exists.** Do not connect public requests directly to the reconciler. |
| Storage and recovery | R2, Azure Blob and OCI object-storage adapters exist. No automated PostgreSQL backup and tested restore pipeline is established. |
| SMS | Provider interface and Telnyx adapter exist; live SMS remains disabled and compliance/STOP handling is incomplete. |
| Deployment | The production app was configured in the existing Mkety Core production environment on the shared `mkety-postgres` service, using the `campaigns` schema. The post-fix deployment failed its health check; campaign send, test-send, SMS, and OCI backup remain disabled. |

## Production evidence checked

The latest application-code CI result is `e9dc087` (2026-11-12); typecheck, build, PostgreSQL migrations/auth-schema checks, and automated tests passed. Later changes on `main` update deployment verification only. The app-code commit copies the imported `scripts` directory into the Docker build stage after earlier failed deployments reported `TS2307` build errors.

The Coolify provisioning workflow verified the app's project, production environment, server, and existing `mkety-postgres` placement; configured `CAMPAIGNS_DB_SCHEMA=campaigns`; kept all send-related gates off; and queued a redeploy after DNS was corrected. The Nov 14 01:35:34 UTC deployment failed with Coolify status `exited:unhealthy`; sanitized deployment logs classify it as `health-or-port-failure`. The workflow's root Coolify token was accepted, but `GET /applications/{uuid}/logs?lines=100` returned HTTP 400, categorized as `container-unavailable`; the app has no running container from which to retrieve runtime logs. This is not a token-permission failure. Use the stored deployment diagnostics to identify the health-check failure; retry runtime logs after the container is running. Earlier deployments reported `TS2307` build errors; the current health failure is different.

After the user supplied the server IP, public DNS resolved `campaign.mkety.com` to `89.168.70.209` (one IPv4 record, no IPv6 record), matching the intended Coolify origin. Direct TLS to that IP with Campaigns SNI returns a self-signed `TRAEFIK DEFAULT CERT` with no Campaigns hostname match. The HTTP port 80 probe reaches Traefik and returns 404. Public `/healthz` and `/readyz` probes fail TLS validation. Coolify reports Traefik running with a resolver configured and HTTP-01 challenge mode; no Cloudflare DNS integration is configured. The app remains `exited:unhealthy`, and the redeploy after DNS correction also failed health. Do not broaden the OCI email-delivery identity to compute; its inventory request still fails with `ValueError`. The approved database target remains the existing `mkety-postgres` service, logical database `mkety`, schema `campaigns`; do not create a separate service or `mkety_campaigns` database. Deployed SHA, migration state, Ops login, tenant isolation, worker behavior, provider readiness, and restore readiness remain unverified.

A read-only comparison of domain-based Coolify applications found that Campaigns uses the same general web-app shape as the healthy siblings: Dockerfile build, HTTPS domain, port 3000, and an HTTP health check. `mkety-zitadel-login` is healthy with its own readiness path `/ui/v2/login/ready` on port 3000; `mkety-domainnameapi-relay` is healthy with its health check disabled on port 3000. A generated `sslip.io` storage-verification container exposes HTTP port 80 and is not a comparable public site. Campaigns differs because Coolify checks `/readyz`, which runs PostgreSQL `SELECT 1`; `/healthz` only checks that the web process responds. Keep the database readiness check until the runtime failure is understood. The current DNS/TLS and HTTP 404 results indicate Traefik has no working route for the unhealthy app; that likely prevents automatic certificate issuance. Diagnose the deployment failure before changing health-check behavior; runtime logs are unavailable while the app has no running container.

## P0 gates before a live campaign

- [ ] Confirm exactly one Coolify app targets this repository's `main` branch and verify its Docker build settings and deployed commit.
- [ ] Verify the app targets the existing `mkety` logical database on `mkety-postgres` with `CAMPAIGNS_DB_SCHEMA=campaigns`; review the migration ledger and schema isolation before relying on production data.
- [ ] Configure runtime secrets in Coolify, bootstrap the first Ops account, verify MFA, and confirm the send/test/SMS gates are explicitly off.
- [x] Create and verify the `campaign.mkety.com` A record to `89.168.70.209`; public DNS now returns exactly that IPv4 address and no IPv6 address.
- [ ] Obtain a valid origin certificate. Traefik still serves its default certificate; check HTTP-01 routing and proxy logs after the app health issue is diagnosed, or configure a scoped Cloudflare DNS challenge credential and resolver.
- [ ] Diagnose the failed health check from stored deployment diagnostics; the root token's runtime-log request returns HTTP 400 `container-unavailable` because the app has no running container.
- [ ] Correct the app startup/readiness issue and deploy successfully. Record the deployed commit SHA, then verify `/healthz`, `/readyz`, Ops OIDC/MFA, tenant isolation, migrations, and worker behavior.
- [x] Verify the campaign DNS A record against the supplied public IPv4 without expanding the OCI email-delivery identity's permissions.
- [ ] Implement and test authenticated ACS and OCI event ingestion, payload normalization, replay defense, and provider subscription verification before exposing any event endpoint.
- [ ] Verify in the deployed app that the persisted emergency stop is on by default and Ops pause prevents both queueing and worker dispatch. Add monitoring, operator alerts, and provider quota/burst limits validated against account limits; the current per-provider interval only paces this app's queue.
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

Repository evidence cannot confirm production health, deployed SHA, actual database ownership, DNS/TLS, provider approval, live delivery, consent quality or restore success. Treat all as unverified until observed in the target environment.
