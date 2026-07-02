# Architecture Decision Records

Records of architecturally-significant decisions for the S3 self-service platform. Numbers
are permanent and never reused. A superseded ADR keeps its number and gains a
`Superseded YYYY-MM-DD by ADR-NNNN` status line.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-aws-native-terraform-runner.md) | AWS-native async Terraform runner (Step Functions + CodeBuild) | Accepted |
| [0002](0002-rest-api-thin-web-form.md) | REST API + thin web form as the entry point | Accepted |
| [0003](0003-audited-escape-paths.md) | Human-approved, fully-audited escape paths (OPA-classified) | Accepted |
| [0004](0004-third-party-resilience.md) | Resilience to third-party outages (circuit breaker + cached fallback) | Accepted |

New ADRs start from [`template.md`](template.md).
