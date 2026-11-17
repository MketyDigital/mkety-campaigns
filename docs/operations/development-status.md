# MKETY Campaigns: implementation status, roadmap, and pilot gates

**Audit date:** 2026-11-16. **Status:** PRs #96, #98, #99, and #101 are merged to `main`. The latest independently verified production deployment finished at 2026-11-15 21:26:29 UTC, before PR #101. The owner now reports the branded site is visible, but the deployed SHA and post-deployment health/readiness checks have not been independently verified. Campaign/test sending, SMS, and OCI backup remain disabled; this is not cleared for a live campaign.

This page describes code on main separately from live operational evidence. Passing CI or merging code proves neither successful deployment nor safe live delivery. The 2026-10-29 design and 2026-10-30 implementation plan remain historical intent.

## Implemented on main

| Area | Current state |
| --- | --- |
| Runtime | TypeScript/Hono app with Node and Cloudflare Worker entry points, Docker, PostgreSQL and D1 migrations, and CI. Coolify/PostgreSQL remains the intended first target. |
| Authentication and tenant access | Invite-only Better Auth, password login, TOTP MFA and backup codes, single business seat, and tenant-scoped APIs. Tenant MFA is enforced in the app. Ops sign-in uses a custom MKETY OIDC flow with an allowlisted, verified email from the signed ID token or the OIDC UserInfo fallback, matching standalone Assist. The app does not require an `amr: mfa` claim; Zitadel's authentication policy remains responsible for enforcing the account's authentication factors. Full production security certification is not established. |
| Providers and domains | ACS and OCI Email Delivery adapters; domain, DNS-verification and sender-readiness workflows. Real credentials, permissions, provider quotas and DNS ownership are unverified. |
| Contacts and consent | Manual/CSV import, consent evidence, withdrawal, suppression and unsubscribe tokens. Tags, segments and export/retention workflows are incomplete. |
| Campaigns | Draft, review, Ops approval, scheduling, explicit queue action and durable per-recipient jobs. Consent and suppression are checked before dispatch. Sending remains disabled unless explicitly enabled. |
| Sending safeguards | Security headers, no-store on protected/auth pages, fail-closed HTTPS unsubscribe validation, per-campaign recipient caps, a persisted email emergency stop checked before queue/worker dispatch, a database-backed per-provider minimum-interval throttle (`EMAIL_PROVIDER_MIN_INTERVAL_MS`, default 1 second; 250 ms–60 seconds), and an atomic per-tenant daily queue budget (default 1,000 queued recipients per UTC day). The interval and daily budget do not enforce vendor quotas, billing limits, or monitoring. |
| Delivery events | Canonical ACS/OCI event contract, idempotent reconciliation and permanent bounce/complaint suppression. **No provider-authenticated public ingestion route or provider subscription verification exists.** Do not connect public requests directly to the reconciler. |
| Storage and recovery | R2, Azure Blob and OCI object-storage adapters exist. No automated PostgreSQL backup and tested restore pipeline is established. |
| SMS | Provider interface and Telnyx adapter exist; live SMS remains disabled and compliance/STOP handling is incomplete. |
| Public frontend and indexing | PR #101 adds the Mkety-branded overview and enterprise page, product-accurate copy, social/SEO metadata, favicon and Apple icon references, `robots.txt`, `sitemap.xml`, and `llms.txt`. App/API/auth/invite/unsubscribe paths are disallowed for crawlers and return `X-Robots-Tag: noindex`. The owner reports the page is live; the deployed code SHA and public route behavior still need independent verification. |
| Deployment | The last independently verified production deployment ran in the existing Mkety Core production environment on the shared `mkety-postgres` service, using schema `campaigns`. Coolify reports `running:healthy`, and the public `/readyz` route and HTTPS certificate are verified. Campaign sends, test sends, SMS, and OCI backup remain disabled. |

## Ops console inventory and next controls

The owner reported a successful MKETY Auth OIDC sign-in on 2026-11-15. PR #96 (`93609c64dcc526671d118b279fecef49aa6f9119`) added workspace controls; PR #98 (`f9def0d356a6c0845cd7bb439da4af7914b87661`) added aggregate usage and delivery summaries; PR #99 (`c6d7a1bddf0c87ec3d007287b171fef03528185d`) added aggregate domain/sender readiness. All three passed CI and their production deployment workflows completed. This separate verifier session could not authenticate to inspect the signed-in dashboard, so an authenticated smoke check of the new UI remains outstanding.

| Ops capability | Current behavior after PR #99 |
| --- | --- |
| Operator identity | OIDC PKCE, verified allowlisted email, app-local hashed session, secure cookie, disabled-operator enforcement. One allowlisted operator; no role or operator-management UI. |
| Workspace provisioning | Create tenant and its single owner seat invitation with contract start/expiry, plan/reference, and per-campaign and per-day email limits. |
| Workspace lifecycle | List workspaces; set approved/suspended, plan, contract dates/reference, and caps. Expiry/status block tenant access and dispatch. Suspension, expiry, future start, or lower caps cancel queued jobs and move campaigns back to review. |
| Owner invites | Single-use seven-day invite with hashed token storage; Ops can list invitation status, rotate a one-time link, and revoke it. No extra employee/team seats. |
| Campaign operations | Review/approve/reject without sending; explicit email queue action; global email emergency stop. Ops actor actions go to campaign_ops_audit; email send/test-send runtime gates remain off. SMS dispatch remains disabled. |
| Customer setup | Tenants manage their own contacts/consent, domains, sender identities, and campaign drafts. Ops does not currently have customer impersonation, contact editing, or sender/domain override controls. |
| Reporting and audit | Campaign queue/review, global runtime status, and on-demand aggregate workspace overview: contact totals, latest consent and suppression counts, campaign status totals, delivery outcomes over 7/30/90 days, verified-domain counts, and ready-sender counts. Contact addresses, message content, DNS verification material, and sender addresses are excluded. Cost accounting and searchable audit/history views are not available yet; audit records are persisted. |

Next Ops product work after PR #99: add searchable campaign/invitation history and an audit-log view with strict pagination and tenant filters; implement owner-seat transfer/recovery with session revocation, verified recipient confirmation, MFA re-enrollment, and an auditable rollback path. Keep customer contact data and consent evidence tenant-scoped; do not add impersonation or destructive data deletion as routine Ops actions.

## Production evidence checked

The latest post-deploy verification ran after PR #99. Coolify reports `running:healthy`; `/healthz` returned HTTP 200 (`ok`) and `/readyz` returned HTTP 200 (`ready`). The latest deployment record finished at 2026-11-15 21:26:29 UTC. The provisioning workflow explicitly kept email campaign sends, test sends, SMS, and OCI backup disabled. Runtime readiness confirms live PostgreSQL connectivity. Coolify still reports `git_commit_sha=HEAD`, so the exact running image SHA is not independently exposed; GitHub Actions confirms the deployment workflow ran from merge commit `c6d7a1bddf0c87ec3d007287b171fef03528185d`.

PR #101 merged on 2026-11-16 after that verification. Its GitHub CI passed typecheck, build, migrations, auth checks, and all existing tests. An early post-merge browser check showed the previous page. The owner subsequently reported that the new branded page is visible. This confirms the user-visible landing page changed, but not the exact deployed SHA, health/readiness endpoints, crawler routes, sender readiness, or delivery gates. Verify those in Coolify and against `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/healthz`, and `/readyz` before considering any send test.

The health-check failure was caused by the runtime image lacking both `curl` and `wget`, which Coolify requires inside the app container to run dashboard-configured HTTP checks. The runtime Docker image now installs `curl`; the strict database-backed `/readyz` check is restored. The temporary `/healthz` platform check and certificate-bypassing diagnostic probe have been removed. Historical failed deployment records may still show the earlier health-check failure; the latest app state is healthy.

Public DNS resolves `campaign.mkety.com` to exactly one IPv4 A record, `89.168.70.209`, and no IPv6 record. Direct TLS verification now succeeds: the certificate is authorized, its subject/SAN matches `campaign.mkety.com`, and its recorded validity ends 2027-02-12. The deployed app is configured for the `main` branch, root Dockerfile, HTTPS domain, and port 3000. Coolify's app metadata reports `git_commit_sha=HEAD`, so the exact deployed source SHA is still not independently exposed by the current verifier.

The production app has 46 runtime variables. The required auth/database variable names are present, as are the complete ACS email, OCI Email Delivery, and Azure domain-management key groups. Credentials, permissions, sender/domain ownership, quotas, and provider delivery have not been live-tested. Coolify marks `DATABASE_URL` as `is_shown_once` and does not return its value via the environment API; the provisioning workflow validates its host/port/database against the existing internal `mkety-postgres` endpoint and configures logical database `mkety` with schema `campaigns`. For that exact internal endpoint, it normalizes `sslmode=require` to `sslmode=no-verify`: PostgreSQL traffic remains TLS-encrypted, but the server certificate is not validated. The successful `/readyz` response confirms the runtime can query the database; GitHub-hosted runners cannot resolve the Docker-only database hostname and cannot validate internal connectivity or grants.

Provisioning keeps email test sends, campaign sends, SMS, and OCI backup disabled. A successful app deployment does not authorize live delivery. The owner reports the first allowlisted Ops OIDC login succeeded; an authenticated dashboard smoke check was not possible in the separate verifier browser. The custom OIDC flow creates its `campaign_ops_users` record on successful login; `scripts/bootstrap-ops.mjs` creates a separate Better Auth account and is not part of this production OIDC flow. The callback accepts a verified allowlisted email from the signed ID token or, when needed, the OIDC UserInfo endpoint, following standalone Assist. The callback does not enforce an MFA assurance claim; Zitadel policy is responsible for the authentication factors applied during sign-in. Tenant isolation, emergency-stop behavior, provider-event authentication/replay handling, provider quotas, encrypted backup/restore, and sender DNS/delivery behavior also remain unverified or incomplete.

## P0 gates before a live campaign

- [x] Confirm one Coolify app is configured for this repository's `main` branch, Dockerfile build, root context, HTTPS domain, and port 3000. The deployment verifier reports deployed SHA as `HEAD`; GitHub Actions confirms the deployment workflow used merge commit `93609c64dcc526671d118b279fecef49aa6f9119`, but exact running-image SHA remains unexposed by Coolify.
- [ ] Review the `campaigns` migration ledger and schema isolation on the existing `mkety` logical database in `mkety-postgres`. The runtime `/readyz` query succeeds, but this does not replace a migration/grant review.
- [x] Complete the first allowlisted Ops OIDC login; the owner reports the login succeeded on 2026-11-15. The custom OIDC callback created its operator record; the separate Better Auth bootstrap script is not used. Zitadel remains responsible for the authentication factors applied during sign-in.
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
- [ ] Keep `EMAIL_CAMPAIGN_SEND_ENABLED=false` until all live-campaign gates pass. The fixed account-owner test-send gate is separate and may be enabled temporarily in the existing workspace only after the provider credentials and domain-management access are configured, the owner is signed in with MFA, and a sender is ready; disable `EMAIL_TEST_SEND_ENABLED` after the owner confirms the inbox check. SMS and OCI backup remain disabled. A one-recipient campaign pilot still requires separate verification and approval.

## Email provider routing follow-up

- Ops can select configured ACS/OCI providers for new domain setup and choose one distinct send fallback. Fallback requires an explicit definitive rejection, an enabled provider adapter, and a ready same-tenant sender using the identical From address. Ambiguous delivery outcomes remain uncertain for reconciliation.
- Ops domain diagnostics retain sanitized provider status/code/request ID. A failed or uncertain domain can switch to the configured alternate only after the original provider returns a provider-specific not-found result; uncertain attempts also wait ten minutes for propagation and use an atomic state transition to prevent concurrent retries.
- To use both providers for campaigns, provision and verify the same sender domain separately with each provider, create a ready sender with the exact same From address on both, and keep the Ops primary/fallback distinct. Fallback sends only after a definitive rejection; timeout, 408/409, 5xx, and local persistence failures never trigger a second send.
- The owner-provided OCI Cloud Shell output confirms `eu-frankfurt-1` is READY, `MketyCampaignsApi` has a registered key and is in the `MketyCampaignsEmail` group, and the tenancy policy grants `manage email-family` in `mkety-campaigns-email`. The domain query in that compartment was empty. This is evidence of OCI IAM readiness and domain absence there, not evidence that the application can send.
- Azure Cloud Shell confirmed `Microsoft.Communication` is registered and the app role is assigned at the Email Service and Communication Service resource scopes; the owner removed the broader resource-group assignment. The subscription's Email Services API list does not include `2025-05-01`, which caused `NoRegisteredProviderFound`; it does include stable `2025-09-01`. The adapter and read-only diagnostics now use `2025-09-01`. Re-run post-deploy diagnostics to confirm the app principal can read the Email Service and domain. The prior ACS data-plane diagnostic timed out, so credentialed send readiness remains unverified.
- OCI diagnostic confirmed the expected OCI secret variables were present, the configured private key derives the configured fingerprint, and the endpoint region matches `eu-frankfurt-1`; the signed control-plane request still returned `401 NotAuthenticated`. The owner confirms the secret names are correct. Verify the secret values still match the `MketyCampaignsApi` tenancy/user/key tuple; do not rotate the key based only on a matching fingerprint. The domain query in `mkety-campaigns-email` was empty.
- PostgreSQL migrations 0104–0106 are required before deployment. Migration 0106 scopes domain and sender uniqueness per provider so a tenant can have the same ready From address on both providers. Existing campaign/test send gates remain unchanged and must stay off unless separately authorized.

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
