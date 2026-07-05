terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend is intentionally omitted from the stripped-bucket module.
  # The parent CodeBuild build uses -backend=false for plan-only validation.
  # A real backend would be wired per-request when live apply is enabled (#25).
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project       = "bucket-broker"
      Module        = "skeleton"
      ManagedBy     = "terraform"
      RequestId     = var.request_id
      CorrelationId = var.correlation_id
    }
  }
}

# ---------------------------------------------------------------------------
# STRIPPED BUCKET MODULE — walking-skeleton scope only.
#
# Implements ONLY the two controls required for the tracer bullet:
#   1. SSE-KMS encryption
#   2. Block Public Access
#
# Intentionally omitted (tracked in modules/golden-bucket, issues #10/#11):
#   - Versioning          → #checkov:skip CKV_AWS_21
#   - Access logging      → #checkov:skip CKV_AWS_18
#   - Lifecycle rules     → #checkov:skip CKV2_AWS_61
#   - Event notifications → #checkov:skip CKV2_AWS_62
#   - Cross-region replication → #checkov:skip CKV_AWS_144
#   - MFA delete          → #checkov:skip CKV_AWS_52
# ---------------------------------------------------------------------------

locals {
  bucket_name = "skeleton-${var.request_id}"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_kms_key" "bucket" {
  description             = "KMS key for skeleton bucket ${local.bucket_name}"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RootAccountAdmin"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "S3ServiceGrant"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })

  tags = {
    Name = "skeleton-bucket-${var.request_id}"
    # Distinguishing tag the CodeBuild runner's KMS IAM condition scopes to, so
    # the runner can act only on per-request bucket keys — never the platform
    # data/logs/tfstate keys, which never carry this tag. (#16 review P0)
    Purpose = "stripped-bucket"
  }
}

resource "aws_kms_alias" "bucket" {
  name          = "alias/skeleton-bucket-${var.request_id}"
  target_key_id = aws_kms_key.bucket.key_id
}

resource "aws_s3_bucket" "bucket" {
  #checkov:skip=CKV_AWS_21:Versioning intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  #checkov:skip=CKV_AWS_18:Access logging intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  #checkov:skip=CKV2_AWS_61:Lifecycle config intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  #checkov:skip=CKV2_AWS_62:Event notifications intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  #checkov:skip=CKV_AWS_144:Cross-region replication intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  #checkov:skip=CKV_AWS_52:MFA delete intentionally omitted from stripped skeleton bucket; deferred to modules/golden-bucket.
  bucket = local.bucket_name
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.bucket.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "bucket" {
  bucket                  = aws_s3_bucket.bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action   = "s3:*"
        Resource = [aws_s3_bucket.bucket.arn, "${aws_s3_bucket.bucket.arn}/*"]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.bucket]
}
