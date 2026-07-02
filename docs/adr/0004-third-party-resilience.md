# ADR-0004 — Resilience to third-party outages (circuit breaker + cached fallback)

**Status:** Accepted 2026-07-02
**TL;DR:** External dependencies (OIDC IdP, notifiers, out-of-process policy engine) are wrapped in circuit breakers with bounded timeouts, retries with jittered backoff, and cached/queued fallbacks; auth fails closed, provisioning degrades gracefully, and no path double-provisions on retry.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

The platform depends on services it does not control. The primary one is the **OIDC identity
provider** (Okta-like): the authorizer validates JWTs against the IdP's JWKS endpoint, and
users obtain tokens from the IdP's login. Secondary dependencies include the **approval
notification channel** (SNS → email/Slack) and, if OPA runs out-of-process, the **policy
engine**. Terraform providers also call the AWS control plane during `apply`.

An outage or slowdown in any of these must not cascade into platform-wide failure, hung
requests, exhausted Lambda concurrency, or — worst of all — a silent bypass of a security
control. The 10-minute provisioning SLO also means we cannot let a flaky dependency burn the
entire budget on blocking retries.

## Decision

Every call to an external dependency is wrapped in a consistent resilience envelope:

- **Bounded timeouts** on every outbound call; no unbounded waits.
- **Circuit breaker** per dependency (closed → open → half-open). When a dependency is
  failing, the breaker opens fast and short-circuits calls to a defined fallback instead of
  piling up blocked invocations.
- **Retry with exponential backoff + full jitter** for transient errors only, capped so the
  worst case stays within the SLO budget.
- **Bulkhead isolation** so a slow dependency can't consume all concurrency shared with
  healthy paths (separate Lambda reserved concurrency / queues per concern).
- **Idempotency keys** on provisioning so any retry (breaker half-open, Step Functions
  retry, client re-submit) never creates a duplicate bucket.

Per-dependency fallback behavior:

- **OIDC IdP / JWKS:** signing keys are cached (with TTL + stale-while-revalidate). Token
  signature validation is offline against cached keys, so the API keeps serving holders of
  valid, unexpired tokens even when the IdP control plane is down. If a token cannot be
  validated (unknown `kid`, no cached key, expired), the authorizer **fails closed → 401**.
  Security is never traded for availability.
- **Approval notifications:** the approval record is persisted first; notification is a
  best-effort async side effect behind the breaker with a retry queue/DLQ. If notification
  fails, the escape request still exists and is reconciled — approvers can also poll a
  pending-approvals view, so a down notifier delays but never drops an escape.
- **Policy engine (OPA):** preferred deployment is **in-process/bundled Rego** (evaluated in
  the Lambda, no network hop), which removes the dependency entirely. If a remote OPA server
  is ever used, its breaker fallback **fails closed** — an unclassifiable request is treated
  as an escape (approval required), never auto-approved.
- **AWS control plane during `apply`:** Step Functions retries with backoff on throttling and
  transient errors; terminal failures route to a DLQ, set `status=FAILED` with the
  correlation-id, and alert. Idempotency ensures a retried apply converges rather than
  duplicates.

Breaker state transitions and fallback activations are logged and emitted as metrics so
degraded operation is observable.

## Alternatives considered

- **Naive retries only (no breaker):** Simpler, but under a sustained outage retries amplify
  load, exhaust Lambda concurrency, and blow the SLO. Rejected — retries without a breaker
  make outages worse.
- **Fail open on auth when the IdP is down:** Maximizes availability but is a security
  bypass — anyone could present an unverifiable token during an outage. Rejected outright;
  auth fails closed.
- **Synchronous notification as a hard prerequisite for creating the approval record:**
  Simpler control flow, but couples escape submission to notifier uptime and can drop
  requests. Rejected in favor of persist-first, notify-after.
- **External/self-hosted OPA server as the default:** More centrally manageable, but adds a
  network dependency on the hot path. Rejected as default; bundled Rego is preferred.

## Consequences

- (+) A third-party outage degrades gracefully instead of cascading: valid sessions keep
  working, escapes are never lost, and provisioning stays within budget or fails cleanly
  with an alert.
- (+) Fail-closed defaults mean no outage can silently weaken authn/authz or auto-approve an
  escape.
- (−) More moving parts: breaker state, key caches, retry queues/DLQs, and idempotency keys
  are all now first-class components that must be built, tuned, and tested (including
  outage-injection / chaos tests).
- (−) During an IdP outage, users without a currently-valid token cannot log in — that path
  depends on the IdP and is outside our control; we surface a clear status rather than hang.
- New work: a shared resilience helper (timeout + breaker + retry) reused across Lambdas, a
  JWKS cache with stale-serve, notification retry/DLQ, and idempotency-key storage.

## Open questions

- Breaker thresholds (failure ratio, open duration, half-open probe count) and JWKS cache TTL
  are starting guesses to be tuned against observed dependency behavior in the dev env.
- Chaos/outage-injection testing: fold into the hardening milestone, or run as a standing
  game-day exercise?
