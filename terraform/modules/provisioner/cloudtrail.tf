# ---------------------------------------------------------------------------
# Interim state-bucket audit trail (#9 iac-5).
#
# Once Terraform state is written live there must be no unaudited window on
# object access. Server access logging on the state bucket is owned by the
# observability module (#23); until it lands, this CloudTrail records
# object-level (data-plane) events for the state bucket to a dedicated,
# hardened, KMS-encrypted audit bucket. Gate off with
# enable_state_bucket_audit_trail once #23 wires access logging.
# ---------------------------------------------------------------------------

locals {
  audit_bucket_name = "${local.prefix}-state-audit-${local.account_id}"
  trail_name        = "${local.prefix}-state-audit"
  trail_arn         = "arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${local.trail_name}"
}

resource "aws_s3_bucket" "audit" { # tfsec:ignore:aws-s3-enable-bucket-logging tfsec:ignore:aws-cloudtrail-require-bucket-access-logging
  count = var.enable_state_bucket_audit_trail ? 1 : 0

  #checkov:skip=CKV_AWS_18:This IS the terminal audit bucket; logging its own access would create a circular chain. Object access here is itself CloudTrail-visible.
  #checkov:skip=CKV_AWS_144:Cross-region replication is not required for an interim audit bucket; tracked for hardening (#24).
  #checkov:skip=CKV2_AWS_62:Event notifications are not part of this interim audit bucket.
  #checkov:skip=CKV2_AWS_6:Public access block IS attached (aws_s3_bucket_public_access_block.audit); checkov's graph does not associate count-indexed companion resources.
  #checkov:skip=CKV2_AWS_61:Lifecycle IS configured (aws_s3_bucket_lifecycle_configuration.audit); count-indexing breaks checkov's cross-resource association.
  #checkov:skip=CKV_AWS_145:SSE-KMS IS configured with the module logs CMK (aws_s3_bucket_server_side_encryption_configuration.audit); count-indexing breaks checkov's association.
  #checkov:skip=CKV_AWS_21:Versioning IS enabled (aws_s3_bucket_versioning.audit); count-indexing breaks checkov's association.
  bucket        = local.audit_bucket_name
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_versioning" "audit" {
  count  = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  count  = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.logs.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  count                   = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket                  = aws_s3_bucket.audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  count  = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
  depends_on = [aws_s3_bucket_public_access_block.audit]
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  count  = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  rule {
    id     = "expire-audit-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  count  = var.enable_state_bucket_audit_trail ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.audit[0].arn, "${aws_s3_bucket.audit[0].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.audit[0].arn
        Condition = { StringEquals = { "aws:SourceArn" = local.trail_arn } }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit[0].arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"      = "bucket-owner-full-control"
            "aws:SourceArn"     = local.trail_arn
            "aws:SourceAccount" = local.account_id
          }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

resource "aws_cloudtrail" "state_audit" { # tfsec:ignore:aws-cloudtrail-ensure-cloudwatch-integration
  count = var.enable_state_bucket_audit_trail ? 1 : 0

  #checkov:skip=CKV2_AWS_10:CloudWatch Logs integration + metric-filter alerting on this interim trail is owned by the observability module (#23); data events are durably delivered to the hardened audit bucket in the meantime.
  #checkov:skip=CKV_AWS_252:An SNS topic for CloudTrail delivery notifications is not required for this interim data-event trail; alerting wiring is owned by the observability module (#23).
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.audit[0].id
  kms_key_id                    = aws_kms_key.logs.arn
  enable_log_file_validation    = true
  include_global_service_events = true
  is_multi_region_trail         = true

  # Object-level (data-plane) events for the state bucket only — the point of
  # this trail is auditing WHO reads/writes state objects.
  event_selector {
    read_write_type           = "All"
    include_management_events = false

    data_resource {
      type   = "AWS::S3::Object"
      values = ["${var.state_bucket_arn}/"]
    }
  }

  tags       = local.tags
  depends_on = [aws_s3_bucket_policy.audit]
}
