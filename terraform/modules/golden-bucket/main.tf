# ---------------------------------------------------------------------------
# golden-bucket — paved-road S3 bucket
#
# Enforced controls (all on by default, no escape hatch in this module):
#   SSE-KMS · Block Public Access (all 4) · versioning · TLS-only bucket policy
#   server access logging · lifecycle (abort multipart + noncurrent expiry)
#   standard tags (team, owner, cost-center, path) · team-scoped CRUD via IAM role
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # Standard tags applied to every resource in this module.
  tags = {
    team        = var.team
    owner       = var.owner
    cost-center = var.cost_center
    path        = var.path
    ManagedBy   = "terraform"
    Module      = "golden-bucket"
  }

  # Log prefix namespaces access logs by source bucket name.
  log_prefix = "${var.bucket_name}/"
}

# ---------------------------------------------------------------------------
# Main bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "bucket" {
  #checkov:skip=CKV_AWS_144:Cross-region replication is not a golden-path default; enabling it requires a destination bucket outside this standalone module. Teams requiring replication should escalate to an escape path or a dedicated DR module.
  #checkov:skip=CKV2_AWS_62:Event notifications are not a golden-path default; they are configured per-workload. This module focuses on storage hardening, not event routing.
  #checkov:skip=CKV_AWS_52:MFA delete cannot be toggled via the Terraform AWS provider without MFA-signed API calls; enabling it requires manual, out-of-band intervention. Teams that require MFA delete must enable it manually post-provisioning.
  bucket        = var.bucket_name
  force_destroy = false

  tags = merge(local.tags, {
    Name = var.bucket_name
  })
}

# Disable ACLs — object ownership is enforced to the bucket owner.
resource "aws_s3_bucket_ownership_controls" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-KMS — uses a module-managed CMK or a caller-supplied key ARN.
resource "aws_s3_bucket_server_side_encryption_configuration" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = local.kms_key_arn
      sse_algorithm     = "aws:kms"
    }
    # Bucket-level key reduces KMS API calls (and cost) for high-throughput buckets.
    bucket_key_enabled = true
  }
}

# Block Public Access — all four settings required; no escape in this module.
resource "aws_s3_bucket_public_access_block" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket_ownership_controls.bucket]
}

# Versioning — enabled by default; required for the noncurrent-expiry lifecycle rule.
resource "aws_s3_bucket_versioning" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Lifecycle — two rules are mandatory for the golden path:
#   1. Abort incomplete multipart uploads to prevent orphaned part charges.
#   2. Expire noncurrent versions to bound storage growth.
resource "aws_s3_bucket_lifecycle_configuration" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  # Rule 1 — abort incomplete multipart uploads
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_upload_days
    }
  }

  # Rule 2 — expire noncurrent object versions
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.bucket]
}

# Server access logging — writes to the dedicated log bucket in this module.
resource "aws_s3_bucket_logging" "bucket" {
  bucket        = aws_s3_bucket.bucket.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = local.log_prefix

  # Ensure the log-delivery bucket policy is in place before logging starts.
  depends_on = [aws_s3_bucket_policy.access_logs]
}

# ---------------------------------------------------------------------------
# Bucket policy
#
# Statement 1 — DenyNonTLS: deny all S3 actions over plaintext HTTP to any
#               principal. BPA prevents public access; this adds defence-in-depth
#               for same-account principals that might reach the bucket via HTTP.
#
# Statement 2 — AllowTeamCRUD: explicitly allow the team IAM role to perform
#               the specific CRUD actions it needs, scoped to this bucket's ARN.
#               IAM policy (iam.tf) is the primary gate; the bucket policy adds
#               a defence-in-depth allow that also satisfies cross-account semantics
#               should the team role ever be moved to a separate account.
# ---------------------------------------------------------------------------
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
      },
      {
        Sid    = "AllowTeamCRUD"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.team.arn
        }
        # Note: s3:GetObjectAcl / s3:PutObjectAcl omitted — BucketOwnerEnforced
        # disables ACLs; granting them would be dead permissions.
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectTagging",
          "s3:GetObjectVersionTagging",
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:ListBucketVersions",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:AbortMultipartUpload",
        ]
        Resource = [aws_s3_bucket.bucket.arn, "${aws_s3_bucket.bucket.arn}/*"]
      },
    ]
  })

  # Ensure BPA is set before applying the policy so block_public_policy
  # is in effect before the policy is written.
  depends_on = [aws_s3_bucket_public_access_block.bucket]
}
