# ADR-0003 — Human-approved, fully-audited escape paths (OPA-classified)

**Status:** Accepted 2026-07-02
**TL;DR:** Golden-path requests auto-provision; any deviation is classified as an escape by an OPA policy, requires human approval, and is recorded to an immutable audit log with a justification.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

A golden path — a safe, opinionated bucket configuration — must be established, along with
escape paths for users who legitimately need to override it. Overrides such as public
access, custom or cross-account bucket policies, off-standard regions, disabled versioning,
or customer-managed KMS keys carry real risk in a hardened platform. The requirement
mandates that escape-path usage be captured and logged.

The tension is between keeping the golden path frictionless and preventing anyone from
self-serving a dangerous configuration. We also want the golden-versus-escape distinction to
be objective and testable rather than a matter of reviewer judgment.

## Decision

An **OPA/Rego** policy deterministically classifies each incoming request as **golden** or
**escape**. Golden requests are auto-approved and provisioned immediately. Escape requests
move to `status=AWAITING_APPROVAL`, notify approvers via SNS, require a logged
justification, and are provisioned only after an approver's decision. Every escape — the
request, the classifier verdict, the justification, the approver, and timestamps — is
written to an **immutable audit log** (a dedicated log group plus an S3 bucket with Object
Lock). OPA classifies; humans approve.

## Alternatives considered

- **Self-serve + logging only:** Overrides allowed without approval but heavily logged,
  tagged, and alerted on. This meets the literal requirement and removes the human
  bottleneck, but it lets anyone self-serve a public or cross-account bucket. Rejected for a
  hardened build.
- **Policy-gated (OPA), no human:** OPA alone decides which overrides are permitted;
  disallowed requests hard-fail. Deterministic and bottleneck-free, but rigid — a legitimate
  one-off override becomes impossible without a code change. Rejected as the sole gate; OPA
  is used to classify, not to make the final allow/deny call.

## Consequences

- (+) The golden path stays frictionless; risky deviations get a human gate and a
  tamper-evident trail; classification is objective and unit-testable.
- (−) Approval adds latency to escape requests. The 10-minute SLO applies to *provisioning*,
  not to *approval wait time* — this must be documented so users understand the distinction.
- (−) The platform needs an approver rotation and a reliable notification path.
- (−) The OPA policy becomes a maintained artifact with its own test suite.

## Open questions

- Approver model: a single platform-team rotation, or per-team approvers for that team's
  buckets? Start with a central rotation; revisit if approval latency becomes a complaint.
