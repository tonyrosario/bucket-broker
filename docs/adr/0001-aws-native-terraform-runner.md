# ADR-0001 — AWS-native async Terraform runner (Step Functions + CodeBuild)

**Status:** Accepted 2026-07-02
**TL;DR:** Bucket provisioning runs Terraform in-account via a Step Functions state machine that invokes a CodeBuild job; no external CI/CD SaaS and no Git-PR dependency.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

A self-service request must result in a provisioned S3 bucket within a 10-minute SLO.
Terraform needs somewhere to execute `apply` with remote state and locking. We are
greenfield: there is no existing Terraform Cloud or Atlantis footprint, no org-standard
CI/CD to inherit, and a strong preference for low, usage-based cost.

The runner sits on the critical path of every provision, so its latency, failure modes, and
cost dominate the platform's operational characteristics. It also determines how the
10-minute SLO is enforced and how escape-path applies are gated (see ADR-0003).

## Decision

An API request lands on a `request-handler` Lambda, which starts a **Step Functions** state
machine. The state machine renders tfvars from the request and invokes a **CodeBuild** job
that runs `terraform init/plan/apply` against the `golden-bucket` module. Terraform state
lives in S3 with a DynamoDB lock table. Provision status is tracked in DynamoDB and
completion emits EventBridge events and CloudWatch metrics. A Step Functions execution
timeout enforces the 10-minute SLO, and a CloudWatch alarm fires if the budget is exceeded.

## Alternatives considered

- **GitOps (Terraform Cloud / Atlantis):** The API opens a PR to an infra repo; TFC or
  Atlantis plans and applies on merge. This gives a free audit trail via Git history and a
  natural PR-based review point for escape paths. Rejected for now: it adds a SaaS license
  and Git dependency, introduces external round-trips, and is heavier than needed for a
  greenfield build. Worth revisiting if an org later standardizes on Terraform Cloud.
- **AWS Service Catalog / Proton:** Wrap the golden bucket as a managed product that the API
  triggers. Least custom code, but rigid escape paths and awkward handling of arbitrary
  policy overrides. Rejected.
- **Terraform inside Lambda:** Run the Terraform binary directly in a Lambda. Rejected: the
  15-minute cap is tight, and packaging the binary plus `/tmp` working space is awkward.
  CodeBuild is purpose-built to run a toolchain.

## Consequences

- (+) Fully serverless and pay-per-use: **idle cost ≈ $0**, roughly 1–2¢ per provision in
  CodeBuild minutes. Everything lives in one account, giving clean end-to-end X-Ray tracing
  and deterministic SLO enforcement.
- (−) We own the runner: state backend, locking, concurrency control, and retries are our
  responsibility. Concurrent runs must be bounded to avoid state-lock contention.
- (−) There is no built-in PR-review UX, so escape-path review must be built explicitly
  (see ADR-0003).
- New work: state-backend bootstrap module, dead-letter queues on async steps, run
  concurrency control, and run-log retention.

## Open questions

- Concurrency ceiling: how many simultaneous CodeBuild applies before state-lock contention
  or account throttling becomes the bottleneck? To be tuned against load in the dev env.
