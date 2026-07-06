# ---------------------------------------------------------------------------
# KMS CMK for the authorizer's CloudWatch log group.
#
# Encrypting the log group at rest with a customer-managed key (rather than the
# default AWS-owned key) keeps auth-failure logs — which record token `kid`s,
# subjects, and denial reasons — under a key whose policy and rotation we
# control. The key policy grants the CloudWatch Logs service principal only the
# operations it needs, scoped by ArnLike to this function's log group.
#
# The policy is inlined with jsonencode (matching the identity module): the
# root-account statement's `"Resource": "*"` refers to the key ITSELF (the only
# expressible resource inside a key policy), which is the standard, required
# shape for a manageable CMK.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "logs" {
  description             = "CMK encrypting the ${local.function_name} CloudWatch log group."
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Root account full access — required so IAM policies in this account can
      # delegate key use and the key stays manageable. "Resource": "*" is the
      # key itself (key policies cannot reference any other resource).
      {
        Sid    = "EnableRootAccountAdmin"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      # CloudWatch Logs service grant — scoped by encryption-context ArnLike to
      # THIS function's log group only, so the key cannot be used to encrypt any
      # other log group's data.
      {
        Sid    = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${local.region}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "${local.log_group_arn}:*"
          }
        }
      },
    ]
  })

  tags = local.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name_prefix}-jwt-authorizer-logs"
  target_key_id = aws_kms_key.logs.key_id
}
