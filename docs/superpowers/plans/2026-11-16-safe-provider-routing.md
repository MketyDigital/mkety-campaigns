# Safe provider routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add audited Ops selection of a configured email primary/fallback, a no-duplicate campaign fallback path, and actionable sanitized domain provisioning diagnostics and guarded fallback retry.

**Architecture:** Keep secrets in runtime environment and provider adapters. Store only provider names in the existing Ops control row. A worker may use one fallback only after an adapter returns a typed, allowlisted definitive rejection and only when a ready same-tenant sender exists for the same From address. Domain fallback is an explicit Ops action that first confirms the domain is absent at the original provider.

**Tech Stack:** TypeScript, Hono, PostgreSQL, node:test, existing ACS and OCI adapters.

**Spec:** `docs/superpowers/specs/2026-11-16-safe-provider-routing-design.md`

## Global Constraints

- Provider secrets stay in Coolify/runtime configuration and never enter Ops API responses or audit detail.
- Ambiguous outcomes never trigger a second send or automatic retry.
- Existing campaign-send, owner-test-send, SMS, backup, consent, and emergency-stop settings remain unchanged.
- Every Ops mutation is authenticated, origin-checked, validated against configured providers, and audited.

## Review Focus

- Primary provider returns success but persistence fails: no fallback call; job remains uncertain.
- Provider timeout, 408/409/5xx, malformed response, or unknown status: no fallback call.
- Primary definitive rejection but alternate sender is missing, unready, cross-tenant, or has a different address: no fallback call.
- Provider configuration is partial or removed after Ops selection: fail closed and expose only a configuration readiness state.
- Domain lookup at original provider fails or returns anything other than confirmed not-found: refuse provider switch.

---

### Task 1: Typed provider outcomes and safe one-shot fallback

**Files:** `src/email/providers.ts`, `src/email/providers.test.ts`, `src/campaigns/delivery.ts`, `src/campaigns/delivery.test.ts`

- [x] Add failing adapter tests proving the allowed rejection statuses are classified as definitive and 408/409/5xx/network errors are ambiguous.
- [x] Add failing worker tests proving only definitive rejection calls the fallback once, while success-persistence errors and uncertain failures never do.
- [x] Add the typed rejection error, stable ACS repeatability headers, and one-shot fallback logic.
- [x] Run targeted tests and typecheck.

### Task 2: Persist and audit Ops provider policy

**Files:** `migrations/postgres/0104_ops_email_provider_routing.sql`, `src/campaigns/delivery-repository.ts`, `src/campaigns/delivery-repository.test.ts`, `src/ops/service.ts`, `src/ops/service.test.ts`, `src/app.ts`, `src/app.test.ts`, `src/node.ts`

- [x] Add tests for default policy, configured-provider validation, invalid same-provider fallback, and audit attribution.
- [x] Add primary/fallback fields, repository/service operations, authenticated GET/PATCH routes, and a branded Ops control panel showing readiness without credentials.
- [x] Wire the persisted policy to campaign claims and provider adapters without changing deployment gates.
- [x] Run targeted tests, full suite, build, migration check, and auth schema check.

### Task 3: Guarded domain diagnostics and alternate-provider recovery

**Files:** `migrations/postgres/0105_domain_provider_diagnostics.sql`, `migrations/postgres/0106_provider_scoped_email_identities.sql`, `src/domains/azure-arm.ts`, `src/domains/oci-email.ts`, `src/domains/service.ts`, `src/domains/repository.ts`, their tests, `src/ops/service.ts`, `src/app.ts`, `src/node.ts`

- [x] Add failing tests for sanitized error persistence, safe Ops listing, and domain fallback refusal unless the original provider confirms 404/not-found.
- [x] Persist only provider name, integer status, validated error code, and sanitized request ID; omit raw response bodies and DNS values from the diagnostic endpoint.
- [x] Add an Ops-only retry path that refreshes if the original domain exists, switches to fallback only when confirmed absent, and becomes non-retryable/inconclusive after an ambiguous provider result.
- [x] Run targeted tests and full validation.

### Task 4: Operational notes and review

**Files:** `docs/email-provider-credentials.md`, `docs/operations/provider-provisioning.md`, `docs/operations/development-status.md`

- [x] Document how to set credentials, choose primary/fallback, prepare the same domain and sender address once on each provider, and reconcile uncertain sends/domain setup.
- [x] Confirm no production sending flags or provider secrets changed; review all changed files and run the full verification command set.
- [x] Open a draft PR with exact release gates and test/deployment caveats.

### Task 5: Reconcile uncertain provider setup safely

**Files:** `src/domains/service.ts`, `src/domains/repository.ts`, `src/app.ts`, their tests, `.github/workflows/read-only-email-provider-diagnostics.yml`

- [x] Let Ops reconcile an old `Unknown` domain through the configured alternate only after the source provider returns an explicit `NotFound` or `ResourceNotFound`; reject OCI `NotAuthorizedOrNotFound`.
- [x] Require a ten-minute propagation window for uncertain create attempts and an atomic `Failed`/`Unknown` state transition before any alternate-provider create request.
- [x] Add a visible Ops action for uncertain records and preserve no-retry behavior for recent or ambiguous outcomes.
- [x] Run provider diagnostics automatically after a successful production deployment; the workflow remains read-only and never sends email.
