# Safe email provider routing

## Intent

Let authenticated MKETY Ops choose one configured email provider as primary and optionally one as fallback, and expose enough sanitized diagnostics to resolve provider-domain setup failures such as the current `email.mkety.com` attempt.

## Goals

- Keep provider credentials exclusively in Coolify/runtime secrets; Ops can see configured status and choose providers, never read or write credentials.
- Persist provider selection and audit every change.
- Attempt campaign fallback only after the primary adapter receives an explicit, definitive non-acceptance response. Timeouts, connection errors, HTTP 408/409/5xx, missing adapters, and local persistence errors remain uncertain and stop automatic delivery.
- Use fallback only when the same tenant has a ready sender identity for the exact same From address on that provider.
- Make failed domain setup diagnosable with sanitized provider, HTTP status, provider error code, and request reference. Never persist raw provider response bodies, tokens, or DNS values in Ops diagnostics.
- Allow Ops to retry a failed domain through the selected fallback only after querying the original provider and confirming the domain is absent there. If existence is found, refresh and display its records; if the lookup is inconclusive, refuse the fallback.
- Keep existing campaign/test-send gates, global emergency stop, consent checks, and tenant scoping unchanged.

## Non-goals

- No automatic retry after an ambiguous send outcome, no automatic fallback for network/timeout/5xx failures, no cross-provider delivery deduplication claim, and no raw credential management in Ops.
- No automatic transfer of domain authentication records between providers; the fallback provider returns its own DNS instructions.
- No enabling campaign sending, SMS, or backups as part of this change.

## Approaches

1. Keep provider choice in deployment configuration and document manual edits. This is low risk but does not give Ops the requested control or expose useful failure diagnostics.
2. Persist a primary/fallback policy in the Ops control row, validate it against runtime-configured adapters, use a typed definitive-rejection result for at-most-one campaign fallback, and add an Ops-only guarded domain retry. This keeps secrets in Coolify and ties every fallback to evidence; selected.
3. Retry through another provider on any failure. Rejected because a timeout or 5xx can follow provider acceptance and would risk duplicate email.

## Constraints and calls

- ACS 202 Accepted means accepted for processing, not delivered. OCI's `opc-retry-token` is an idempotency token with a limited retention window. Fallback safety must not depend on either provider's idempotency behavior: only an explicit definitive rejection permits a cross-provider attempt.
- A successful provider response is terminal for routing even if later persistence fails; record uncertain and do not call another provider.
- Existing sender records are provider-bound. The fallback sender must be ready in the same tenant and match the From address exactly.
- Use existing Postgres Ops auth middleware and audit table. Provider selection has no effect on global kill switches.

## Builder decisions

- Store `primary_email_provider` and nullable `fallback_email_provider` in `campaign_ops_controls`; a missing row value resolves to the deployment's current configured provider and no fallback.
- Use an explicit allowlist of provider response statuses that prove non-acceptance; treat every unrecognized status as ambiguous.
- Show domain diagnostic entries in Ops with domain reference, domain name, provider, sanitized status/code, and correlation reference; retry action is server guarded and Ops-authenticated.
