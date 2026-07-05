# identity module

IdP-flexible identity substrate for the bucket-broker platform.

## What this module provisions

| Resource | Purpose |
|---|---|
| `aws_kms_key` (CMK) | Encrypts the entitlements table and OIDC JWKS URI SSM param |
| `aws_ssm_parameter` × 3 | OIDC issuer (String), audience (String), JWKS URI (SecureString) |
| `aws_dynamodb_table` (entitlements) | Maps IdP group → `{can_create, teams[], access{read,write,delete}}` |
| `aws_iam_role` × N | One role per `team_groups` entry; OIDC trust conditioned on group claim |

## Swapping the IdP (zero code changes)

The platform deliberately avoids hardcoding any IdP specifics. Every IdP-specific
value lives in variables that write to SSM at apply time. The request-handler Lambda
reads config from SSM at runtime.

To migrate from one OIDC-compliant IdP to another:

1. Update the OIDC provider registration in your AWS account
   (`aws_iam_openid_connect_provider` — account-scoped, created separately).
2. Update your module call:
   - `oidc_issuer` → new issuer URL
   - `oidc_audience` → new audience / client ID
   - `oidc_jwks_uri` → new JWKS URI
   - `oidc_provider_arn` → new OIDC provider ARN
   - `team_groups` → update group name values to match the new IdP's claim names
3. `terraform apply` — SSM parameters and IAM role trust conditions are updated.
4. Update the entitlements table `group` keys to match the new IdP's group claim names
   (DynamoDB `UpdateItem` / migration script — no Terraform changes needed for data).

No Lambda code, no application logic, and no IAM policy documents outside this module
need to change. The IAM role names (referenced in bucket policies) are derived from team
names, not IdP group names — they remain stable across migrations.

## Entitlements table schema

| Attribute | DynamoDB type | Description |
|---|---|---|
| `group` (PK) | String (S) | IdP group name — must match the `groups` claim in the JWT exactly. |
| `can_create` | Boolean (BOOL) | Whether group members may provision new buckets. |
| `teams` | List of String (L) | Team identifiers this group administers (used to scope bucket access). |
| `access.read` | Boolean (BOOL, nested in Map) | Allows S3 `GetObject` on team-owned buckets. |
| `access.write` | Boolean (BOOL, nested in Map) | Allows S3 `PutObject` on team-owned buckets. |
| `access.delete` | Boolean (BOOL, nested in Map) | Allows S3 `DeleteObject` on team-owned buckets. |

Example item (DynamoDB JSON):

```json
{
  "group":      { "S": "platform-eng" },
  "can_create": { "BOOL": true },
  "teams":      { "L": [{ "S": "platform" }, { "S": "infra" }] },
  "access": {
    "M": {
      "read":   { "BOOL": true },
      "write":  { "BOOL": true },
      "delete": { "BOOL": true }
    }
  }
}
```

See `examples/complete/main.tf` for an `aws_dynamodb_table_item` fixture using this schema.

## IAM trust policy — group → role mapping

Each entry in `var.team_groups` produces an IAM role with this trust policy shape:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "<oidc_provider_arn>" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals":            { "<issuer-host>:aud": "<oidc_audience>" },
    "ForAnyValue:StringEquals": { "<issuer-host>:groups": "<idp_group_name>" }
  }
}
```

- `StringEquals` on `aud` prevents cross-application token reuse.
- `ForAnyValue:StringEquals` on `groups` handles array-valued OIDC claims correctly
  (matches when any element in the claim array equals the configured group name).
- The `Federated` principal is the specific OIDC provider ARN — never a wildcard.

The IAM role carries **no inline permissions**. Downstream modules (golden-bucket,
platform-api) attach scoped bucket and SSM permissions to these role ARNs.

## OIDC provider

The AWS IAM OIDC provider (`aws_iam_openid_connect_provider`) is **account-scoped**
(only one provider per issuer URL per account). Create it separately — for example in
an account-bootstrap module — and pass the ARN as `var.oidc_provider_arn`. This avoids
conflicts when multiple environments share an AWS account.

Example (run once per account):

```hcl
resource "aws_iam_openid_connect_provider" "idp" {
  url             = "https://dev-12345.example-idp.com"
  client_id_list  = ["api://bucket-broker"]
  thumbprint_list = ["<real-thumbprint-from-idp-certificate>"]
}
```

## Required inputs

| Variable | Type | Description |
|---|---|---|
| `name_prefix` | string | Short prefix for resource names |
| `oidc_issuer` | string | OIDC issuer URL (`https://...`) |
| `oidc_audience` | string | OIDC audience / client ID |
| `oidc_jwks_uri` | string (sensitive) | JWKS URI (`https://...`) |
| `oidc_provider_arn` | string | IAM OIDC provider ARN |

## Optional inputs

| Variable | Default | Description |
|---|---|---|
| `ssm_path_prefix` | `/{name_prefix}/oidc` | SSM path prefix |
| `entitlements_table_name` | `{name_prefix}-entitlements` | DynamoDB table name override |
| `team_groups` | `{}` | Map of team_name → IdP group name |
| `kms_deletion_window_days` | `7` | KMS key deletion window |
| `tags` | `{}` | Additional resource tags |

## Key outputs

| Output | Description |
|---|---|
| `entitlements_table_name` | DynamoDB table name (for Lambda env vars) |
| `entitlements_table_arn` | DynamoDB table ARN (for IAM policy scoping) |
| `kms_key_arn` | Identity CMK ARN (grant `kms:Decrypt` to consumers) |
| `ssm_oidc_issuer_name` | SSM param name for OIDC issuer |
| `ssm_oidc_audience_name` | SSM param name for OIDC audience |
| `ssm_oidc_jwks_uri_name` | SSM param name for OIDC JWKS URI (SecureString) |
| `team_role_arns` | Map of team_name → IAM role ARN |
