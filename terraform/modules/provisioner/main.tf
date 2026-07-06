# ---------------------------------------------------------------------------
# provisioner — async Terraform runner (ADR-0001)
#
# Step Functions renders tfvars from a request (glue Lambda), runs a CodeBuild
# job that applies the golden-bucket module against the S3+DynamoDB backend,
# tracks status in DynamoDB (PENDING -> PROVISIONING -> READY/FAILED), DLQs on
# failure, bounds concurrency, and enforces the 10-minute SLO via an execution
# timeout.
#
# Security posture (see README "Security design" and the per-resource comments):
#   - Two-identity runner: the CodeBuild service role is minimal (logs + assume);
#     ALL terraform runs under a per-request ABAC session of the provisioning
#     role, whose permissions resolve to the EXACT request's bucket/key/role via
#     the BucketName/Team/RequestId session tags (iam.tf). No account-wide grants.
#   - State-KMS use is pinned to kms:ViaService (s3+dynamodb) + aws:SourceAccount.
#   - CodeBuild source pinned to an immutable commit SHA.
#   - tfvars are rendered as JSON (never string-concatenated HCL) by the glue.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition
  prefix     = var.prefix

  # Every state file for a provisioned bucket lives under this key prefix; the
  # runner's state object access is scoped to it (never the whole bucket).
  state_key_prefix = "provisioned"

  # kms:ViaService values that gate the runner's use of the STATE key. The
  # runner only ever touches the state key THROUGH S3 (state objects) and
  # DynamoDB (lock table) — never via a direct KMS API call — so a leaked
  # credential cannot decrypt an exfiltrated state blob out-of-band (#9 iac-1).
  state_kms_via_services = [
    "s3.${local.region}.amazonaws.com",
    "dynamodb.${local.region}.amazonaws.com",
  ]

  tags = merge(var.tags, {
    Project   = "bucket-broker"
    Module    = "provisioner"
    ManagedBy = "terraform"
  })
}
