# aws-s3-self-service

Self-service platform for provisioning golden-path Amazon S3 buckets. A user hits a URL,
authenticates via an OIDC identity provider (Okta-like, config-driven), and gets a
team-owned, hardened S3 bucket provisioned within a **10-minute SLO** — with audited
escape paths for anyone who needs to override the golden defaults.

## Status

Greenfield. High-level design is complete and approved. This repo currently contains the
**design + architecture decision records**. Implementation is decomposed into
independently-grabbable vertical slices (see `docs/design/architecture.md`) and built via
parallel, worktree-isolated agents.

## Key decisions

| # | Decision | ADR |
|---|----------|-----|
| 1 | AWS-native async Terraform runner (Step Functions → CodeBuild) | [ADR-0001](docs/adr/0001-aws-native-terraform-runner.md) |
| 2 | REST API + thin web form as the entry point | [ADR-0002](docs/adr/0002-rest-api-thin-web-form.md) |
| 3 | Human-approved, fully-audited escape paths (OPA-classified) | [ADR-0003](docs/adr/0003-audited-escape-paths.md) |
| 4 | Resilience to third-party outages (circuit breaker + cached fallback) | [ADR-0004](docs/adr/0004-third-party-resilience.md) |

## Layout

```
docs/
  design/architecture.md   # target architecture, module map, decomposition, verification
  adr/                     # architecture decision records (+ template)
terraform/                 # modules + envs   (to be implemented)
src/                       # lambda handlers + web form  (to be implemented)
```

## Cost

Fully serverless / pay-per-use. Idle cost ≈ $0; ~1–2¢ per bucket provision (CodeBuild
minutes); a few dollars/month at demo volume.
