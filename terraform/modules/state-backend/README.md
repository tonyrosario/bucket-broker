# modules/state-backend

Bootstrap module that provisions the remote Terraform state backend consumed by every other stack in this platform. It is designed to be applied **once per environment** before any other module.

## Resources created

| Resource | Purpose |
|---|---|
| `aws_kms_key.state` | Customer-managed CMK for encrypting both the S3 bucket and the DynamoDB table |
| `aws_kms_alias.state` | Human-readable alias (`alias/<prefix>-tfstate`) |
| `aws_s3_bucket.state` | Versioned, KMS-encrypted bucket that stores `.tfstate` files |
| `aws_s3_bucket_versioning` | State history (noncurrent versions retained for rollback) |
| `aws_s3_bucket_server_side_encryption_configuration` | SSE-KMS with bucket key enabled |
| `aws_s3_bucket_public_access_block` | All four BPA settings enabled |
| `aws_s3_bucket_ownership_controls` | `BucketOwnerEnforced` — ACLs disabled |
| `aws_s3_bucket_lifecycle_configuration` | Expires noncurrent state versions after N days |
| `aws_s3_bucket_policy` | Deny-non-TLS policy (`aws:SecureTransport = false`) |
| `aws_dynamodb_table.lock` | Lock table (LockID PK) with KMS encryption and PITR |

## Security properties

- **KMS CMK with rotation**: annual automatic rotation; key policy follows the account-root-admin convention — root gets `kms:*`, DynamoDB service gets minimum actions scoped to the source account, and optional Terraform runner principals get exactly `kms:GenerateDataKey` + `kms:Decrypt` + `kms:DescribeKey`.
- **S3 Block Public Access**: all four settings (`block_public_acls`, `block_public_policy`, `ignore_public_acls`, `restrict_public_buckets`) are forced true.
- **TLS-only bucket policy**: a Deny statement on `s3:*` with `aws:SecureTransport = false` covers the bucket and all objects.
- **No hardcoded account IDs or regions**: the key policy uses `data.aws_caller_identity` and `data.aws_region` at apply time.

## Usage

### Step 1 — Bootstrap (local state, first apply only)

On first apply the bucket and table do not yet exist, so you must use local state:

```hcl
# envs/dev/state-backend/main.tf
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No backend block — local state only for this bootstrap apply.
}

provider "aws" {
  region = "us-east-1"
}

module "state_backend" {
  source = "../../../terraform/modules/state-backend"

  prefix = "bucket-broker-dev"

  tags = {
    Project     = "bucket-broker"
    Environment = "dev"
    Team        = "platform"
    ManagedBy   = "terraform"
  }

  # Explicit KMS grant for the CodeBuild terraform runner role.
  terraform_state_principals = [
    "arn:aws:iam::123456789012:role/bucket-broker-dev-codebuild-runner",
  ]
}

output "backend_config" {
  value = {
    bucket         = module.state_backend.state_bucket_name
    dynamodb_table = module.state_backend.lock_table_name
    kms_key_id     = module.state_backend.kms_key_arn
  }
}
```

```bash
terraform init
terraform apply
```

Note the output values for the next step.

### Step 2 — Switch to remote state

Add the `backend "s3"` block and re-init to migrate local state into the new bucket:

```hcl
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "bucket-broker-dev-tfstate"       # module output: state_bucket_name
    key            = "state-backend/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "bucket-broker-dev-tflock"        # module output: lock_table_name
    encrypt        = true
    kms_key_id     = "arn:aws:kms:us-east-1:123456789012:key/..."  # module output: kms_key_arn
  }
}
```

```bash
terraform init   # prompts to copy local state to the new backend
```

### Step 3 — Consume in other stacks

Every other stack references the same backend bucket with a different `key`:

```hcl
backend "s3" {
  bucket         = "bucket-broker-dev-tfstate"
  key            = "golden-bucket/terraform.tfstate"
  region         = "us-east-1"
  dynamodb_table = "bucket-broker-dev-tflock"
  encrypt        = true
  kms_key_id     = "arn:aws:kms:us-east-1:123456789012:key/..."
}
```

Bucket name, table name, and key ARN can be fed from Terraform outputs via `-backend-config` flags or a `backend.hcl` file to keep them DRY.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `prefix` | `string` | required | Naming prefix for all resources. Must be unique per account+region. |
| `tags` | `map(string)` | `{}` | Tags applied to all resources. |
| `noncurrent_version_retention_days` | `number` | `90` | Days to retain old state versions. |
| `kms_deletion_window_days` | `number` | `30` | KMS key deletion waiting period (7–30). |
| `terraform_state_principals` | `list(string)` | `[]` | IAM role/user ARNs granted explicit KMS access. |

## Outputs

| Name | Description |
|---|---|
| `state_bucket_name` | S3 bucket name → `bucket` in backend config |
| `state_bucket_arn` | S3 bucket ARN → IAM policies for the runner role |
| `lock_table_name` | DynamoDB table name → `dynamodb_table` in backend config |
| `lock_table_arn` | DynamoDB table ARN → IAM policies for the runner role |
| `kms_key_arn` | KMS key ARN → `kms_key_id` in backend config + IAM policies |
| `kms_key_id` | KMS key short ID (UUID) |
| `kms_alias_name` | KMS alias name (console reference) |

## Terraform runner IAM policy

The role that runs `terraform init/plan/apply` (e.g. CodeBuild) needs at minimum:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket",
    "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration"
  ],
  "Resource": [
    "<state_bucket_arn>",
    "<state_bucket_arn>/*"
  ]
},
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"
  ],
  "Resource": "<lock_table_arn>"
},
{
  "Effect": "Allow",
  "Action": [
    "kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"
  ],
  "Resource": "<kms_key_arn>"
}
```

## Known limitations / deferred

- **Access logging**: skipped in this module; the central log delivery bucket is owned by the observability module (#23). Wire `aws_s3_bucket_logging` at that point.
- **Cross-region replication**: not wired; tracked for the hardening milestone (#24).
- **S3 event notifications**: not applicable for a Terraform state bucket; skipped.
