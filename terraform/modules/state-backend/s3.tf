# ---------------------------------------------------------------------------
# S3 state bucket — versioned, KMS-encrypted, Block Public Access fully on,
# ACLs disabled (BucketOwnerEnforced), and a TLS-only bucket policy.
#
# Skips (justified):
#   CKV_AWS_18 / aws-s3-enable-bucket-logging: Access logging requires a
#     separate log-delivery bucket. The central log bucket is owned by the
#     observability module (#23). Logging will be wired at that point.
#   CKV_AWS_144: Cross-region replication is not required for Terraform state;
#     versioning provides sufficient history for rollback. Tracked for
#     hardening milestone (#24).
#   CKV2_AWS_62: S3 event notifications are not applicable to a Terraform
#     state bucket; state transitions are driven by CLI, not S3 events.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" { # tfsec:ignore:aws-s3-enable-bucket-logging
  #checkov:skip=CKV_AWS_18:Access logging deferred; central log bucket owned by observability module (#23).
  #checkov:skip=CKV_AWS_144:Cross-region replication not required for Terraform state; versioning covers rollback. Tracked for hardening (#24).
  #checkov:skip=CKV2_AWS_62:S3 event notifications not applicable to a Terraform state bucket.
  bucket = "${var.prefix}-tfstate"

  lifecycle {
    prevent_destroy = true
  }

  tags = var.tags
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.state.arn
      sse_algorithm     = "aws:kms"
    }
    # Bucket key reduces KMS API call volume and cost for high-throughput state access.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Disable legacy ACLs — all access is via bucket policy only.
resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

  depends_on = [aws_s3_bucket_public_access_block.state]
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Deny any request that does not use TLS (HTTPS). The deny on s3:* with
# the aws:SecureTransport=false condition is the canonical AWS pattern for
# enforcing in-transit encryption on S3 buckets.
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.state.arn,
          "${aws_s3_bucket.state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })

  # Ensure BPA is applied before the policy, so block_public_policy=true
  # does not race with setting a new policy.
  depends_on = [aws_s3_bucket_public_access_block.state]
}
