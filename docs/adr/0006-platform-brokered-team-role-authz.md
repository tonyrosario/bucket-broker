# ADR-0006 — Platform-brokered team-role authorization

**Status:** Accepted 2026-07-05
**TL;DR:** Team IAM roles are assumed by the platform backend after an entitlements check — not by user tokens via an OIDC `groups` claim (which AWS STS does not support as a trust condition key). Team→group authorization lives in the authorizer + entitlements table + bucket policy.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

The authorization model (see `docs/design/architecture.md`) grants a team access to its
buckets through a per-team IAM role, and states that a team role's trust "maps back to the
IdP group." The first implementation of the identity module (#12) took that literally: each
team role federated to the IdP's IAM OIDC provider and gated `sts:AssumeRoleWithWebIdentity`
on a trust condition `ForAnyValue:StringEquals { "<issuer>:groups" = <team group> }`, so a
user holding a JWT whose `groups` claim contained the team's group could assume the role
directly.

The independent review of that module found this does not work. For a generic OIDC provider,
AWS STS projects only a fixed set of claims (`aud`, `sub`, `amr`) into the IAM request context
as condition keys; arbitrary and array-valued custom claims such as `groups` are not surfaced.
The condition therefore references an absent key. The most likely runtime behavior is that the
roles are simply unassumable (fail-closed, broken). The dangerous behavior is that, because a
single audience is shared across every team role, if the `groups` condition is ever made
ineffective-but-passing (a refactor to `...IfExists`, dropping the line, or an issuer-prefix
mismatch), any authenticated platform user could assume any team role.

Crucially, the platform's authoritative authorization decision does not depend on this
mechanism: it lives in the entitlements table, evaluated by the request-handler. The
`groups`-in-trust-condition was a redundant, unsupported second implementation of the same
intent.

## Decision

We adopt **platform-brokered team-role assumption**. Team IAM roles trust only the platform
**backend** principals (the request-handler / provisioner execution roles), passed as
`var.broker_principal_arns`, and are assumed with `sts:AssumeRole`. There is no OIDC federation
in the trust policy and no `groups` condition.

Team→group authorization is enforced upstream, where the design already places the source of
truth: the JWT authorizer validates the token, the request-handler checks the caller's
entitlements (group→team) against the entitlements table, and only then does the backend assume
the correct team role on the caller's behalf. Bucket policies continue to reference the team
role ARNs for scoped S3 access. Because STS federation is not used, the platform no longer needs
an `aws_iam_openid_connect_provider`; user tokens are validated against the IdP's JWKS endpoint
(ADR-0004).

## Alternatives considered

- **User-assumed roles gated on the `groups` claim (the original #12 approach).** Keep users
  assuming per-team roles directly via `AssumeRoleWithWebIdentity`. Rejected: generic OIDC STS
  does not surface `groups` as a condition key, so the control is unenforceable as written.
  Making it work would require the concrete production IdP to project `groups` into the STS
  context (not the case for standard OIDC), pinning it, and a negative test — and even then the
  shared-audience shape makes it a fragile single point of failure.
- **Per-team audiences / OIDC clients** to give each team an independently-enforceable `aud`.
  Rejected: heavy IdP-side operational burden (one client registration per team) for a control
  the entitlements table already provides more flexibly.

## Consequences

- (+) The authorization gate is the entitlements table + authorizer + bucket policy — one
  source of truth, testable in code, with no dependency on unsupported STS behavior. It cannot
  fail open.
- (+) The identity module no longer requires an IAM OIDC provider; IdP swaps touch only SSM
  config + entitlements data.
- (−) The backend must hold `sts:AssumeRole` on the team roles and is now a trusted broker — its
  execution role is security-sensitive and must itself be least-privilege and auditable.
- (−) Downstream work inherits gates: the request-handler (#19) must be **read-only** on the
  entitlements table (a write path there is an authz-bypass primitive), and the golden-bucket /
  platform-api wiring (#10, #18) must pass concrete backend principal ARNs, not federate.

## Open questions

- Whether the backend assumes a distinct role per team (current design) or a single broker role
  with per-request scoped-down session policies is an implementation choice deferred to #19; both
  are compatible with this decision.
