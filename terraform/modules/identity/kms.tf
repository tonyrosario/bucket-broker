# ---------------------------------------------------------------------------
# KMS — Customer-Managed Key for the identity module.
#
# One CMK encrypts:
#   • DynamoDB entitlements table (server-side encryption)
#   • SSM SecureString parameter (JWKS URI)
#
# Separate from module keys for other modules: each module owns its CMK so
# IAM grants can be scoped to exactly the resources that need access.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "identity" {
  description             = "${var.name_prefix}: identity module encryption (entitlements table + OIDC SSM params)"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Root account full access — allows IAM policies to delegate key use.
      # "Resource": "*" is required in key policies (it refers to the key itself).
      {
        Sid    = "RootAccountAdmin"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      # DynamoDB service grant — allows the DynamoDB service to use the key
      # for server-side encryption on behalf of this account only.
      {
        Sid    = "DynamoDBServiceGrant"
        Effect = "Allow"
        Principal = {
          Service = "dynamodb.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_kms_alias" "identity" {
  name          = "alias/${var.name_prefix}-identity"
  target_key_id = aws_kms_key.identity.key_id
}
