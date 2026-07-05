# ---------------------------------------------------------------------------
# KMS customer-managed key — one key encrypts both the S3 state bucket and
# the DynamoDB lock table. Rotation is enabled automatically (annual).
#
# Key policy design:
#   RootAccountAdmin  — kms:* to the AWS account root. This is the standard
#                       account-admin convention; it also allows IAM policies
#                       attached to specific roles to grant further access
#                       without requiring key-policy edits.
#   DynamoDBService   — minimum actions for server-side encryption of the lock
#                       table, conditioned on the source account.
#   TerraformStateUsers (optional) — explicit grant to caller-supplied IAM
#                       principal ARNs (e.g. CodeBuild runner role) for the
#                       minimum actions needed to read/write SSE-KMS state.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
}

resource "aws_kms_key" "state" {
  description             = "${var.prefix}: CMK for Terraform state (S3 bucket + DynamoDB lock table)"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # Standard account-root admin statement. Grants no access to any
          # specific user/role — IAM policies on those identities control access.
          Sid    = "RootAccountAdmin"
          Effect = "Allow"
          Principal = {
            AWS = "arn:aws:iam::${local.account_id}:root"
          }
          Action   = "kms:*"
          Resource = "*"
        },
        {
          # Least-privilege grant for DynamoDB server-side encryption.
          # Scoped to this account to prevent cross-account abuse.
          Sid    = "DynamoDBServiceEncryption"
          Effect = "Allow"
          Principal = {
            Service = "dynamodb.amazonaws.com"
          }
          Action = [
            "kms:GenerateDataKey",
            "kms:Decrypt",
            "kms:DescribeKey",
          ]
          Resource = "*"
          Condition = {
            StringEquals = {
              "aws:SourceAccount" = local.account_id
            }
          }
        },
      ],
      # Optional explicit grant to Terraform runner principals.
      # Only kms:GenerateDataKey + kms:Decrypt + kms:DescribeKey are needed
      # for SSE-KMS state reads/writes; no broader access is granted.
      length(var.terraform_state_principals) > 0 ? [
        {
          Sid    = "TerraformStateUsers"
          Effect = "Allow"
          Principal = {
            AWS = var.terraform_state_principals
          }
          Action = [
            "kms:GenerateDataKey",
            "kms:Decrypt",
            "kms:DescribeKey",
          ]
          Resource = "*"
        }
      ] : []
    )
  })

  tags = var.tags
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.prefix}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}
