# golden-bucket

Opinionated paved-road S3 bucket module for the bucket-broker platform.

Implements the full golden-path control set required by the platform architecture:

| Control | Implementation |
|---------|---------------|
| SSE-KMS | `aws_s3_bucket_server_side_encryption_configuration` — module-managed CMK or caller-supplied key |
| Block Public Access | All four BPA flags set to `true`; cannot be overridden via this module |
| Versioning | Enabled by default; required for noncurrent-expiry lifecycle rule |
| TLS-only bucket policy | `DenyNonTLS` statement blocks all `s3:*` over plaintext HTTP |
| Server access logging | Dedicated hardened log bucket in the same module; ACL-free log delivery via bucket policy |
| Lifecycle | Abort incomplete multipart uploads (default 7 d); expire noncurrent versions (default 90 d) |
| Standard tags | `team`, `owner`, `cost-center`, `path` (golden\|escape) on every resource |
| Team-scoped CRUD | IAM role with a finite S3 + KMS action list scoped to this bucket's ARN |

## Usage

```hcl
module "team_data_bucket" {
  source = "./modules/golden-bucket"

  bucket_name        = "acme-platform-data-prod"
  team               = "platform"
  owner              = "platform@acme.example.com"
  cost_center        = "CC-1234"
  trusted_principals = [aws_iam_role.platform_runner.arn]
}

# Access the team role ARN for downstream wiring
output "team_role_arn" {
  value = module.team_data_bucket.team_role_arn
}
```

### With a caller-supplied KMS key (escape path)

```hcl
module "escape_bucket" {
  source = "./modules/golden-bucket"

  bucket_name        = "acme-data-escape-prod"
  team               = "data"
  owner              = "data@acme.example.com"
  cost_center        = "CC-9999"
  path               = "escape"
  kms_key_arn        = aws_kms_key.custom.arn
  trusted_principals = [aws_iam_role.data_runner.arn]
}
```

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `bucket_name` | `string` | required | Globally-unique S3 bucket name (lowercase, 3–63 chars) |
| `team` | `string` | required | Owning team name; used in tags and IAM role name |
| `owner` | `string` | required | Owner identifier (e.g. team email alias) |
| `cost_center` | `string` | required | Cost-center code for the `cost-center` tag |
| `trusted_principals` | `list(string)` | required | IAM role/user ARNs that may assume the team bucket-access role |
| `path` | `string` | `"golden"` | Provisioning path (`golden` or `escape`); applied as the `path` tag |
| `kms_key_arn` | `string` | `""` | Existing CMK ARN; leave empty to have the module create one |
| `aws_region` | `string` | `"us-east-1"` | AWS region |
| `noncurrent_version_expiration_days` | `number` | `90` | Days until noncurrent versions are deleted |
| `abort_incomplete_multipart_upload_days` | `number` | `7` | Days until incomplete multipart uploads are aborted |
| `log_retention_days` | `number` | `365` | Days until access log objects are deleted from the log bucket |
| `kms_deletion_window_days` | `number` | `30` | Pending-deletion window for a module-managed KMS key |

## Outputs

| Name | Description |
|------|-------------|
| `bucket_arn` | ARN of the golden bucket |
| `bucket_id` | ID (name) of the golden bucket |
| `bucket_domain_name` | Regional domain name of the golden bucket |
| `kms_key_arn` | ARN of the KMS key in use (module-managed or caller-supplied) |
| `kms_key_id` | Key ID of the module-managed CMK; empty string if caller-supplied |
| `log_bucket_arn` | ARN of the server access log bucket |
| `log_bucket_id` | ID (name) of the server access log bucket |
| `team_role_arn` | ARN of the team CRUD IAM role |
| `team_role_name` | Name of the team CRUD IAM role |

## Security design

### IAM least privilege

The team IAM role is granted a **finite list** of S3 actions (no `s3:*`) scoped
to this bucket's ARN only (`Resource: [bucket_arn, bucket_arn/*]`). KMS
data-plane actions (`kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey`)
are scoped to the key ARN **and** guarded by the `kms:ViaService` condition so
the role cannot use the key outside the S3 context. No `iam:PassRole` or
resource wildcards are granted.

### Bucket policy

Two statements:
1. **DenyNonTLS** — `Deny s3:* to Principal:* when aws:SecureTransport=false`.
   Unconditionally blocks all plaintext-HTTP access regardless of IAM policy.
2. **AllowTeamCRUD** — `Allow [finite action list] to team role on bucket ARN`.
   Defence-in-depth; IAM policy is the primary gate.

### KMS key policy (module-managed key only)

Three statements:
1. **RootKeyAdmin** — account root retains full key admin rights (AWS-recommended
   escape hatch; delegates data-plane access to IAM so no per-role key policy
   statement is needed, and the resource-graph cycle is avoided).
2. **S3BucketSSE** — S3 service can generate/decrypt data keys, scoped to this
   account via `aws:SourceAccount`.
3. **S3LogDeliverySSE** — S3 log-delivery service can generate/decrypt data keys
   for writing access logs to the log bucket, scoped to this account.

### Intentional skips (justified)

| Check | Resource | Reason |
|-------|----------|--------|
| `CKV_AWS_52` (MFA delete) | main + log bucket | Terraform cannot issue MFA-signed API calls; must be enabled manually post-provisioning if required |
| `CKV_AWS_144` (cross-region replication) | main + log bucket | Not a golden-path default; teams requiring replication use an escape path or a dedicated DR module |
| `CKV2_AWS_62` (event notifications) | main + log bucket | Not required by the golden-path spec; configured per-workload |
| `CKV_AWS_18` (access logging on log bucket) | log bucket | Terminal log bucket; circular logging is not required |

## Tests

Module tests live in `tests/golden_bucket.tftest.hcl` and use `mock_provider`
(no live AWS credentials required). Run them with:

```shell
terraform -chdir=terraform/modules/golden-bucket test
```

Five test runs cover:

1. Golden path with a module-managed KMS key (plan assertions on all controls)
2. Escape path with a caller-supplied key ARN (no new CMK; key ARN propagated)
3. Invalid bucket name rejected by variable validation
4. Invalid `path` value rejected by variable validation
5. Empty `trusted_principals` list rejected by variable validation

## Provider requirements

| Provider | Version |
|----------|---------|
| `hashicorp/aws` | `~> 5.0` |

Terraform `>= 1.9.0` is required (mock provider support + `terraform test`).
