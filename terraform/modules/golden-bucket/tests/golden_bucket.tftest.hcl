# ---------------------------------------------------------------------------
# golden-bucket module tests (terraform test, TF >= 1.9)
#
# All runs use mock_provider so no live AWS credentials are required.
# Tests validate the plan-time resource attributes that enforce the controls
# mandated by the golden-path spec (architecture.md, issue #10).
#
# Note: AWS provider ~>5.0 represents several S3 sub-resource blocks (rule,
# versioning_configuration, apply_server_side_encryption_by_default) as sets
# rather than lists. Assertions use for-expressions rather than [0] indexing.
# ---------------------------------------------------------------------------

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "AIDAJQABLZS4A3QDU576Q"
    }
  }

  mock_data "aws_region" {
    defaults = {
      name        = "us-east-1"
      description = "US East (N. Virginia)"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }

  # Provide a valid ARN so aws_iam_role_policy_attachment's ARN validation
  # passes under `command = apply` (mock_provider otherwise generates a
  # non-ARN string). Needed by the encryption_pinning_enforced run.
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/mock-team-crud"
    }
  }
}

# ---------------------------------------------------------------------------
# Test 1 — golden path, module-managed KMS key
# ---------------------------------------------------------------------------
run "golden_path_new_kms_key" {
  variables {
    bucket_name        = "acme-platform-data-2001"
    team               = "platform"
    owner              = "platform@acme.example.com"
    cost_center        = "CC-1234"
    trusted_principals = ["arn:aws:iam::123456789012:role/platform-runner"]
  }

  command = plan

  # Bucket name matches input
  assert {
    condition     = aws_s3_bucket.bucket.bucket == "acme-platform-data-2001"
    error_message = "Bucket name must match the bucket_name variable."
  }

  # A new CMK is created when kms_key_arn is empty
  assert {
    condition     = length(aws_kms_key.bucket) == 1
    error_message = "A module-managed KMS key must be created when kms_key_arn is not provided."
  }

  # KMS key rotation is enabled
  assert {
    condition     = aws_kms_key.bucket[0].enable_key_rotation == true
    error_message = "KMS key rotation must be enabled."
  }

  # SSE algorithm is aws:kms (rule is a set in provider v5)
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.bucket.rule :
      alltrue([
        for d in r.apply_server_side_encryption_by_default :
        d.sse_algorithm == "aws:kms"
      ])
    ])
    error_message = "SSE algorithm must be aws:kms."
  }

  # Bucket key is enabled
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.bucket.rule :
      r.bucket_key_enabled == true
    ])
    error_message = "Bucket key must be enabled to reduce KMS API call cost."
  }

  # All four BPA flags
  assert {
    condition     = aws_s3_bucket_public_access_block.bucket.block_public_acls == true
    error_message = "block_public_acls must be true."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.bucket.block_public_policy == true
    error_message = "block_public_policy must be true."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.bucket.ignore_public_acls == true
    error_message = "ignore_public_acls must be true."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.bucket.restrict_public_buckets == true
    error_message = "restrict_public_buckets must be true."
  }

  # Versioning enabled (versioning_configuration is a set in provider v5)
  assert {
    condition = alltrue([
      for v in aws_s3_bucket_versioning.bucket.versioning_configuration :
      v.status == "Enabled"
    ])
    error_message = "Versioning must be enabled."
  }

  # Standard tags
  assert {
    condition     = local.tags["path"] == "golden"
    error_message = "path tag must default to 'golden'."
  }

  assert {
    condition     = local.tags["team"] == "platform"
    error_message = "team tag must equal the team variable."
  }

  assert {
    condition     = local.tags["cost-center"] == "CC-1234"
    error_message = "cost-center tag must equal the cost_center variable."
  }

  # IAM role naming convention
  assert {
    condition     = aws_iam_role.team.name == "golden-bucket-platform-acme-platform-data-2001"
    error_message = "IAM role name must follow the 'golden-bucket-<team>-<bucket>' convention."
  }

  # Both lifecycle rules enabled (rule is a set in provider v5)
  assert {
    condition = length([
      for r in aws_s3_bucket_lifecycle_configuration.bucket.rule : r if r.status == "Enabled"
    ]) == 2
    error_message = "Both lifecycle rules (abort-incomplete-multipart and expire-noncurrent-versions) must be enabled."
  }

  # Log bucket follows naming convention
  assert {
    condition     = aws_s3_bucket.access_logs.bucket == "acme-platform-data-2001-access-logs"
    error_message = "Log bucket name must follow the '<bucket_name>-access-logs' convention."
  }

  # Log bucket also has all four BPA flags
  assert {
    condition     = aws_s3_bucket_public_access_block.access_logs.block_public_acls == true
    error_message = "Log bucket block_public_acls must be true."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.access_logs.block_public_policy == true
    error_message = "Log bucket block_public_policy must be true."
  }
}

# ---------------------------------------------------------------------------
# Test 2 — escape path, caller-supplied KMS key
# ---------------------------------------------------------------------------
run "escape_path_existing_kms_key" {
  variables {
    bucket_name        = "acme-data-escape-9901"
    team               = "data"
    owner              = "data@acme.example.com"
    cost_center        = "CC-9999"
    path               = "escape"
    kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"
    trusted_principals = ["arn:aws:iam::123456789012:role/data-team-runner"]
  }

  command = plan

  # No new CMK when key ARN is supplied
  assert {
    condition     = length(aws_kms_key.bucket) == 0
    error_message = "No module-managed KMS key must be created when kms_key_arn is provided."
  }

  # Supplied key ARN is used for SSE
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.bucket.rule :
      alltrue([
        for d in r.apply_server_side_encryption_by_default :
        d.kms_master_key_id == "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"
      ])
    ])
    error_message = "The caller-supplied KMS key ARN must be used for SSE."
  }

  # path tag is 'escape'
  assert {
    condition     = local.tags["path"] == "escape"
    error_message = "path tag must be 'escape' when the path variable is 'escape'."
  }
}

# ---------------------------------------------------------------------------
# Test 6 — encryption-pinning: writes must land under the module CMK (#10 review)
# Uses command = apply so the rendered bucket-policy JSON is known (references
# the bucket ARN, unknown at plan). mock_provider supplies the values.
# ---------------------------------------------------------------------------
run "encryption_pinning_enforced" {
  variables {
    bucket_name        = "acme-data-pin-9902"
    team               = "data"
    owner              = "data@acme.example.com"
    cost_center        = "CC-9999"
    kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"
    trusted_principals = ["arn:aws:iam::123456789012:role/data-team-runner"]
  }

  command = apply

  assert {
    condition     = strcontains(aws_s3_bucket_policy.bucket.policy, "DenyIncorrectEncryptionHeader") && strcontains(aws_s3_bucket_policy.bucket.policy, "DenyWrongKMSKey")
    error_message = "Bucket policy must include the encryption-pinning deny statements (deny non-KMS SSE and deny wrong KMS key)."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.bucket.policy, "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab")
    error_message = "Encryption-pinning deny must reference the module CMK ARN."
  }
}

# ---------------------------------------------------------------------------
# Test 3 — variable validation: invalid bucket name is rejected
# ---------------------------------------------------------------------------
run "invalid_bucket_name_rejected" {
  variables {
    bucket_name        = "INVALID_NAME_WITH_CAPS_AND_UNDERSCORES"
    team               = "platform"
    owner              = "platform@acme.example.com"
    cost_center        = "CC-1234"
    trusted_principals = ["arn:aws:iam::123456789012:role/platform-runner"]
  }

  command         = plan
  expect_failures = [var.bucket_name]
}

# ---------------------------------------------------------------------------
# Test 4 — variable validation: invalid path value is rejected
# ---------------------------------------------------------------------------
run "invalid_path_rejected" {
  variables {
    bucket_name        = "acme-platform-data-2002"
    team               = "platform"
    owner              = "platform@acme.example.com"
    cost_center        = "CC-1234"
    path               = "unrestricted"
    trusted_principals = ["arn:aws:iam::123456789012:role/platform-runner"]
  }

  command         = plan
  expect_failures = [var.path]
}

# ---------------------------------------------------------------------------
# Test 5 — variable validation: empty trusted_principals list is rejected
# ---------------------------------------------------------------------------
run "empty_trusted_principals_rejected" {
  variables {
    bucket_name        = "acme-platform-data-2003"
    team               = "platform"
    owner              = "platform@acme.example.com"
    cost_center        = "CC-1234"
    trusted_principals = []
  }

  command         = plan
  expect_failures = [var.trusted_principals]
}
