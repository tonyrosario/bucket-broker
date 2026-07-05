# ---------------------------------------------------------------------------
# Server access log bucket
#
# A dedicated, hardened S3 bucket that receives access logs from the main
# golden bucket. It is co-located in the same module to keep the module
# self-contained (standalone/pure per architecture.md).
#
# ACL note: S3 server access logging with ACLs disabled (BucketOwnerEnforced)
# is supported since 2023 via bucket policy. The log-delivery service principal
# is explicitly allowed to PutObject on this bucket via the bucket policy below.
# ---------------------------------------------------------------------------

#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_18:Enabling access logging on the log bucket itself would create a circular chain. This is the terminal log bucket; logs do not need to be logged again.
  #checkov:skip=CKV_AWS_144:Cross-region replication of access logs is not required for the golden path. Replicate manually if compliance mandates it.
  #checkov:skip=CKV2_AWS_62:Event notifications on the log bucket are not part of the golden-path baseline.
  #checkov:skip=CKV_AWS_52:MFA delete cannot be toggled via Terraform without MFA-signed API calls; same constraint applies here as on the main bucket.
  bucket        = "${var.bucket_name}-access-logs"
  force_destroy = false

  tags = merge(local.tags, {
    Name    = "${var.bucket_name}-access-logs"
    Purpose = "s3-access-logs"
  })
}

# Disable ACLs on the log bucket.
resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-KMS using the same key as the main bucket.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = local.kms_key_arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

# Block Public Access — all four settings.
resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
}

# Versioning on the log bucket.
# Log objects are immutable by nature; versioning is enabled for consistency
# with the golden-path standard and to protect against accidental deletion.
resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Lifecycle for log objects.
resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.log_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_upload_days
    }
  }

  rule {
    id     = "expire-noncurrent-log-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  depends_on = [aws_s3_bucket_versioning.access_logs]
}

# Log bucket policy:
#   Statement 1 — DenyNonTLS: same TLS-only guard as the main bucket.
#   Statement 2 — AllowS3LogDelivery: permit the S3 log-delivery service to
#                 write access logs. Scoped to this account and the source bucket
#                 ARN to prevent confused-deputy abuse.
resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

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
        Resource = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid    = "AllowS3LogDelivery"
        Effect = "Allow"
        Principal = {
          Service = "logging.s3.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.access_logs.arn}/${local.log_prefix}*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
          ArnLike = {
            "aws:SourceArn" = aws_s3_bucket.bucket.arn
          }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}
