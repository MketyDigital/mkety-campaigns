# MKETY Campaigns: implementation status, roadmap, and pilot gates

**Audit date:** 2026-11-11. **Scope:** `MketyDigital/mkety-campaigns` default branch (`main` at `66e08c2`), source files, migrations, CI workflow, architecture/design docs, and open pull requests. **Status:** development / closed-pilot preparation, **not verified production-ready**.

This document is the current implementation-status index. The 2026-10-29 design and 2026-10-30 implementation plan remain architectural intent, not evidence that every feature was shipped. Reconcile this page with `main` whenever a PR is merged or a production gate is verified.

## How to read the statuses

- **On main:** code is present in the default branch; this does not mean live deployment or production validation.
- **Draft PR:** code proposed outside `main`; it may have passing CI, but production does not include it.
- **Partial / pending:** some code exists but a required workflow, compliance control, or operational proof is missing.
- **Unverified:** cannot be established from repository files or CI results; confirm on the actual Coolify/OCI/provider deployment.

## Implemented on main (code, not necessarily production)

| Workstream | Status | Evidence / qualification |
| --- | --- | --- |
| Standalone runtime | On main | TypeScript/Hono, Node entry, Workers/D1 entry, Dockerfile, CI, health/readiness routes. Coolify/PostgreSQL is the first target. |
| Data model | On main | PostgreSQL and D1 migrations 0001–0009, tenant seats, contacts, consent, suppressions, sender identities, campaigns, delivery jobs/attempts, audit records. |
| Security and access | On main | Better Auth invite-only sign-in, TOTP/backup codes, MFA-and-seat checks for tenant routes and Ops role. Full security review, row-level security, and production configuration not certified. |
| Provider domain onboarding | On main | ACS Azure ARM and OCI domain/DKIM/sender implementations with verification state. Credentials, actual DNS, and successful live provisioning unverified. |
| Contacts and consent | On main | CSV/manual import, consent evidence, withdrawal, per-channel suppression and opaque unsubscribe tokens. Tags/segments are not a finished feature. |
| Campaign workflow | On main | Draft, submit, Ops review, approval, scheduling, explicit queue action, capped recipients, tenant-safe job lookups, pre-dispatch consent check, safe uncertain outcomes. Live sends require `EMAIL_CAMPAIGN_SEND_ENABLED=true` and are off by default. |
| Email providers | On main | ACS/OCI Email Delivery adapters with mocked tests and provider-routed jobs. Provider accept does not prove inbox delivery. OCI adapter does not currently pass custom List-Unsubscribe headers into its API payload; message body footer is separate. |
| SMS | Partial / disabled | Neutral contract + Telnyx send adapter; no approved market/sender/registration, live STOP handling, country pricing and cap verification. `SMS_ENABLED=false` default. |
| Object storage | Partial | R2, OCI S3, Azure Blob adapter code; no scheduled, verified archive/backup and restore pipeline. A configured adapter is not an active backup. |
| CI | On main | Checks TypeScript, build, PostgreSQL migrations/auth schema and tests. Does not validate a live Coolify deployment, real providers, restores, or a production smoke test. |
| Cloudflare deployment | Optional / not activated | Worker entry, D1 schema and cron example exist. Coolify with a dedicated PostgreSQL database remains the intended production target. |

## Open development PRs as audited on 2026-11-11

| PR | Work | CI observed | Merge dependency |
| --- | --- | --- | --- |
| [#1](https://github.com/MketyDigital/mkety-campaigns/pull/1) | Original bootstrap; description now dated relative to main | Older foundation claim | Review and close or reconcile; do not blindly merge stale branch |
| [#5](https://github.com/MketyDigital/mkety-campaigns/pull/5) | Browser security headers and cache policy | Pass (run 49) | main |
| [#6](https://github.com/MketyDigital/mkety-campaigns/pull/6) | Fail-closed unsubscribe URL validation | Pass (run 50) | main |
| [#7](https://github.com/MketyDigital/mkety-campaigns/pull/7) | Canonical validated provider event contract | Pass (run 51) | main |
| [#8](https://github.com/MketyDigital/mkety-campaigns/pull/8) | PostgreSQL/D1 idempotent event reconciliation and bounce/complaint suppression | Pass (run 53) | #7; currently targets #7 branch |
| [#9](https://github.com/MketyDigital/mkety-campaigns/pull/9) | PostgreSQL integration tests for event reconciliation | Pass (run 54) | #8; currently targets #8 branch |
| [#10](https://github.com/MketyDigital/mkety-campaigns/pull/10) | Atomic per-tenant UTC daily email queue budget; default 1000 | Pass (run 55) | main |

**All seven were open at audit time; none is in `main`.** CI is necessary but not sufficient to merge or deploy. When merging stacked PRs #7 → #8 → #9, rebase/retarget and review each final diff. PR #10's budget counts **queued recipients**, not messages successfully delivered or monetary spend.

## Major differences from the original implementation plan

1. The **design** refers to Drizzle ORM and a dedicated worker process. Current code uses direct SQL repositories and the Node app runs a guarded, three-second in-process worker timer. Keep this distinction explicit when planning durability and deployment topology.
2. The original design mentions a shared PostgreSQL server/database; the operational rule is a **dedicated `mkety_campaigns` database**, never a shared application schema.
3. The original plan calls for strict environment validation, linting and automated restore tests. The current CI uses `typecheck`, `build`, migrations and `test`, but has no lint script or backup-restore test pipeline.
4. The docs describe R2 as the primary object store. Storage adapters exist; an end-to-end runtime object lifecycle and audited backup scheduler have not been proven.
5. The README references tags, segments, templates and budgets as planned. Draft PR #10 is only a **daily queue budget**, not tenant plans, provider quotas or full cost control.
6. CI verifies PostgreSQL migrations; direct SQLite/D1 tests exist, but full Cloudflare production parity and deploy behavior have not been certified.
7. The Coolify domain workflow searches for exactly one app matching repository and branch. Latest main history includes a failed-match diagnostic; do not interpret presence of the workflow as a successful deployment.

## Prioritized roadmap and acceptance evidence

### P0 — Do before enabling any live campaign sending

- [ ] **Merge/reconcile security PRs:** review #5 and #6, run CI on final merge result, verify response headers and unsubscribe behavior in deployment.
- [ ] **Deliver authenticated provider events:** merge #7 → #8 → #9 after review, then implement provider-specific ACS/OCI event subscription verification, authenticated normalization, replay-safe ingestion and event end-to-end tests. Do **not** expose public webhook endpoints to the raw canonical validator.
- [ ] **Verify deployment:** find exact Coolify application/branch, dedicated PostgreSQL database identity, migration ledger, TLS/DNS for `campaign.mkety.com`, `/healthz` and `/readyz`, safe secrets injection and worker logs. Deployment status is currently **unverified**.
- [ ] **Verify sender onboarding:** provider account/quotas and permissions, owned DNS/SPF/DKIM/DMARC, approved From identity, separate fixed recipient test email, actual delivery and opt-out.
- [ ] **Emergency stop and throttle:** explicit operational stop, global/provider delivery pacing and operator monitoring; a three-second Node poll is not a proven cross-instance/provider rate limit. Review #10 for daily queue budget and add per-provider rate/cost constraints.
- [ ] **Recovery:** automated encrypted PostgreSQL backup, backup integrity/retention monitoring, restore into isolated database, RPO/RTO evidence. Existing object-store adapters do not back up PostgreSQL automatically.
- [ ] **Security review:** tenant isolation across every query/event, session security, input limits, secret-scoping and rate limiting, CSP and incident procedures.
- [ ] **Document owner signoff:** keep `EMAIL_CAMPAIGN_SEND_ENABLED=false` until all pilot gates are met. For initial testing set per-campaign cap to 1 and disable again immediately afterwards.

### P1 — Controlled email pilot

- [ ] Templates and safe preview (HTML and text); tags and dynamic segments; permission evidence and campaign exclusions.
- [ ] Per-tenant/provider plans, quotas, billing/spend visibility, accepted/delivered/bounced/complained reports, and operator alerts.
- [ ] Transactional or scheduled lifecycle for object assets/exports and backup/archive manifests.
- [ ] End-to-end provider integration, reconciliation of ambiguous outcomes, one-recipient smoke test, rollback rehearsal, deliverability monitoring.
- [ ] Explicit tenant export, privacy retention and deletion workflows.
- [ ] Confirm whether single Ops seat/bootstrap/transfer and invitation flows meet operational requirements.

### P2 — Later, behind distinct approvals

- [ ] SMS country/sender verification, legal registration, SMS opt-out/STOP processing, pricing controls and provider events; keep disabled.
- [ ] Cloudflare Workers/D1 parity and migration/restore exercise; no automatic cutover.
- [ ] OCI infrequent-access object backup activation only after 31-day minimum retention, IAM, test restore and cost approval.
- [ ] Provider migration/offboarding plan for ACS/OCI with controlled reputation and DNS changes.

## Release/runbook checklist (no secret values in logs)

1. Confirm repository SHA and reviewed PR sequence. Require successful CI at the *final* merged SHA.
2. Confirm the Coolify target matches this repository's `main` branch; check production database name is independently `mkety_campaigns`.
3. Review and apply migrations as a separately authorized, rollback-aware release step.
4. Confirm `BETTER_AUTH_URL` is the expected HTTPS origin and the auth secret is strong; verify MFA and Ops permissions.
5. Confirm `EMAIL_CAMPAIGN_SEND_ENABLED=false`, `EMAIL_TEST_SEND_ENABLED=false` and `SMS_ENABLED=false` before deployment.
6. Test public health, database readiness, authenticated portal and tenant isolation. Review worker state and provider config without printing credentials.
7. Demonstrate restore of a separate database backup, and separately restore archived object samples. Record timestamps and restore outcomes.
8. For a **separately approved** pilot, use one consented owned mailbox, ready verified sender, an explicit one-recipient queue, provider acceptance/inbox observation, authenticated bounce/complaint event test, unsubscribe and suppression check. Disable send gate at completion.
9. Capture operator signoff, deployment SHA, smoke-test evidence, backup proof, and rollback decision.

## Documentation index

- [Architecture, scope and phased roadmap](../../README.md)
- [Original platform design (historical intent)](../superpowers/specs/2026-10-29-mkety-campaigns-platform-design.md)
- [Original delivery-order plan (historical intent)](../superpowers/plans/2026-10-30-mkety-campaigns-implementation-plan.md)
- [Email provider credentials and controlled test procedure](../email-provider-credentials.md)
- [Storage and backup credential guidance](../storage-credentials.md)
- [Provider infrastructure provisioning commands](provider-provisioning.md)
- [CI workflow](../../.github/workflows/ci.yml)
- [Coolify domain workflow](../../.github/workflows/coolify-domain.yml)

## Audit limits

Repository source and GitHub Actions cannot confirm production health, deployed version, real DNS/SSL status, actual Coolify environment contents, live ACS/OCI sender approval or delivery, backup recovery, or tenant real-world consent. The publicly configured `campaign.mkety.com` endpoints could not be independently verified during the audit. Treat these as **unverified**, not proven healthy or proven down.
