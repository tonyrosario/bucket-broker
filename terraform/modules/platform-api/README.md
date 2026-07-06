# `platform-api` — JWT authorizer slice (issue #17)

This module is being built up across issues. **Issue #17 delivers only the JWT
authorizer Lambda and its least-privilege IAM.** The rest of `platform-api`
(API Gateway REST, WAF, throttling, the request-handler Lambda, and the request
table) belongs to **#19** and is intentionally not in this file set.

## What #17 provisions

| Resource | Purpose |
|----------|---------|
| `aws_lambda_function.authorizer` | The REQUEST authorizer (code in `src/authorizer`, Node.js 20 / TS). Validates JWT vs cached JWKS, fails closed, forwards identity + groups. |
| `aws_iam_role.authorizer` + inline policy | Least-privilege execution role. |
| `aws_cloudwatch_log_group.authorizer` | CMK-encrypted log group (pre-created so the role needs no `CreateLogGroup`). |
| `aws_kms_key.logs` / alias | CMK encrypting the log group. |

### Least-privilege IAM (what the authorizer can do — and nothing else)

- `ssm:GetParameter` / `ssm:GetParameters` on **exactly** the three OIDC
  parameter ARNs (issuer, audience, jwks-uri) — no `ssm:*`, no path wildcard.
- `kms:Decrypt` on **only** the identity CMK (needed to read the SecureString
  JWKS URI parameter).
- `logs:CreateLogStream` / `logs:PutLogEvents` on **only** this function's own
  log group.

The authorizer does **authN only** (ADR-0006): it validates the token and
forwards `sub` + `groups` in the authorizer context. It never reads the
entitlements table and never makes an authorization decision — that is brokered
by the request-handler (#19).

## Inputs (wired from the identity module, #12)

```hcl
module "identity" {
  source = "../identity"
  # ...
}

module "platform_api" {
  source      = "../platform-api"
  name_prefix = "bucket-broker"

  # OIDC config — names for the Lambda env, ARNs for IAM scoping.
  ssm_oidc_issuer_name    = module.identity.ssm_oidc_issuer_name
  ssm_oidc_audience_name  = module.identity.ssm_oidc_audience_name
  ssm_oidc_jwks_uri_name  = module.identity.ssm_oidc_jwks_uri_name
  ssm_oidc_parameter_arns = [
    module.identity.ssm_oidc_issuer_arn,
    module.identity.ssm_oidc_audience_arn,
    module.identity.ssm_oidc_jwks_uri_arn,
  ]
  oidc_kms_key_arn = module.identity.kms_key_arn

  # The built authorizer deployment package.
  lambda_package_path = "${path.module}/../../dist/authorizer.zip"

  # Optional: JWKS cache / resilience tunables (all have code defaults).
  additional_environment_variables = {
    JWKS_CACHE_TTL_MS = "600000"
    CLOCK_SKEW_SEC    = "60"
    GROUPS_CLAIM      = "groups"
  }
}
```

## Outputs (the seam #19 extends)

| Output | #19 uses it for |
|--------|-----------------|
| `authorizer_lambda_invoke_arn` | `aws_api_gateway_authorizer.authorizer_uri` |
| `authorizer_lambda_function_name` / `_arn` | `aws_lambda_permission` so API Gateway may invoke the authorizer |
| `authorizer_log_group_name` | observability (#22) metric filters / alarms (auth-failure rate) |
| `authorizer_role_arn` | auditing |

## Boundary for #19 (do not duplicate)

When #19 lands, it adds — in **separate, clearly-named files** — the API Gateway
REST API, `aws_api_gateway_authorizer` (type `REQUEST`, referencing the invoke
ARN above with `identity_source = "method.request.header.Authorization"`), the
`aws_lambda_permission` granting API Gateway invoke, WAF, throttling, the
request-handler Lambda, and the request table. #17 deliberately creates **none**
of those, so the two slices compose without merge conflicts.

## Runtime environment (set by the module)

`SSM_OIDC_ISSUER_NAME`, `SSM_OIDC_AUDIENCE_NAME`, `SSM_OIDC_JWKS_URI_NAME` are
always injected. Additional tunables (JWKS TTL, breaker thresholds, clock skew,
groups claim name) can be supplied via `additional_environment_variables`; all
have safe code defaults in `src/authorizer`.

## Scanner suppressions

A few checkov skips on the Lambda carry inline justifications: DLQ
(`CKV_AWS_116`, N/A for synchronous authorizers), VPC (`CKV_AWS_117`, needs
public IdP egress), env-var KMS (`CKV_AWS_173`, env holds only non-secret param
names), and code-signing (`CKV_AWS_272`, deferred to hardening #24).
