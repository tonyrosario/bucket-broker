# ---------------------------------------------------------------------------
# Customer-managed KMS key — created only when kms_key_arn is not supplied.
# When an existing key is provided the caller is responsible for its policy.
# ---------------------------------------------------------------------------

locals {
  create_kms_key = var.kms_key_arn == ""
  kms_key_arn    = local.create_kms_key ? aws_kms_key.bucket[0].arn : var.kms_key_arn
}

resource "aws_kms_key" "bucket" {
  count = local.create_kms_key ? 1 : 0

  description             = "CMK for golden-bucket '${var.bucket_name}' owned by team '${var.team}'"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  multi_region            = false

  # Key policy:
  #   Statement 1 — account root retains administrative control (AWS-recommended
  #                 escape hatch; delegates data-plane access to IAM).
  #   Statement 2 — S3 service can generate/decrypt data keys for SSE-KMS.
  #   Statement 3 — S3 log-delivery service can write encrypted access logs.
  #
  # The team IAM role receives data-plane access via its attached managed policy
  # (kms:GenerateDataKey + kms:Decrypt scoped to this key ARN). Because the root
  # statement delegates to IAM, no separate key policy statement is needed for the
  # role — and adding one would create a resource-graph cycle (IAM policy → key ARN;
  # key policy → role ARN).
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RootKeyAdmin"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "S3BucketSSE"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid    = "S3LogDeliverySSE"
        Effect = "Allow"
        Principal = {
          Service = "logging.s3.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })

  tags = merge(local.tags, {
    Name    = "golden-bucket-${var.bucket_name}"
    Purpose = "golden-bucket-sse"
  })
}

resource "aws_kms_alias" "bucket" {
  count = local.create_kms_key ? 1 : 0

  name          = "alias/golden-bucket-${var.bucket_name}"
  target_key_id = aws_kms_key.bucket[0].key_id
}
