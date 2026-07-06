# ---------------------------------------------------------------------------
# Team IAM role — scoped CRUD on this bucket only
#
# Design:
#   - Trust policy: only the caller-supplied principals (e.g. platform
#     provisioner role, OIDC-federated IdP group role) may assume this role.
#   - Permissions policy: finite S3 action list scoped to this bucket's ARN
#     (no s3:* / Resource:*). KMS actions scoped to the key used for SSE.
#   - No iam:PassRole, no service wildcards, no resource wildcards.
# ---------------------------------------------------------------------------

# Trust policy — who may assume the team role.
data "aws_iam_policy_document" "team_trust" {
  statement {
    sid     = "AllowTrustedPrincipals"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.trusted_principals
    }
  }
}

resource "aws_iam_role" "team" {
  name               = "golden-bucket-${var.team}-${var.bucket_name}"
  description        = "Team '${var.team}' scoped CRUD access to S3 bucket '${var.bucket_name}'"
  assume_role_policy = data.aws_iam_policy_document.team_trust.json

  # Platform-provisioned team roles carry a permissions boundary that caps them
  # to the golden-bucket CRUD surface (#18 P0-2). Null when unset (standalone use).
  permissions_boundary = var.team_role_permissions_boundary_arn != "" ? var.team_role_permissions_boundary_arn : null

  # Prevent accidental deletion while the bucket exists.
  force_detach_policies = false

  tags = merge(local.tags, {
    Name = "golden-bucket-${var.team}-${var.bucket_name}"
  })
}

# Permissions policy — finite S3 + KMS actions, bucket-ARN-scoped.
data "aws_iam_policy_document" "team_crud" {
  # S3 object-level actions — scoped to objects in this bucket only.
  # tfsec:ignore:aws-iam-no-policy-wildcards — `bucket_arn/*` is the correct
  # and only way to express "all objects in a specific bucket" in S3 IAM policy.
  # It is NOT a wildcard resource; it is a resource ARN path scoped to this
  # single bucket. Using a narrower resource would break all object operations.
  statement {
    sid    = "S3ObjectCRUD"
    effect = "Allow"
    # Note: s3:GetObjectAcl / s3:PutObjectAcl are intentionally omitted.
    # BucketOwnerEnforced (object ownership) disables ACLs on this bucket;
    # granting ACL actions would be dead permissions.
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
      "s3:GetObjectVersionTagging",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.bucket.arn}/*"] #tfsec:ignore:aws-iam-no-policy-wildcards
  }

  # S3 bucket-level actions — scoped to this bucket only.
  statement {
    sid    = "S3BucketList"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:GetBucketLocation",
    ]
    resources = [aws_s3_bucket.bucket.arn]
  }

  # KMS data-plane access — scoped to the key used for SSE-KMS.
  # kms:ViaService restricts usage to S3 in the deployed region, preventing
  # the team role from using the key outside the S3 context.
  statement {
    sid    = "KMSDecryptGenerateForS3"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [local.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "team_crud" {
  name        = "golden-bucket-crud-${var.team}-${var.bucket_name}"
  description = "Scoped CRUD policy for team '${var.team}' on S3 bucket '${var.bucket_name}'"
  policy      = data.aws_iam_policy_document.team_crud.json

  tags = merge(local.tags, {
    Name = "golden-bucket-crud-${var.team}-${var.bucket_name}"
  })
}

resource "aws_iam_role_policy_attachment" "team_crud" {
  role       = aws_iam_role.team.name
  policy_arn = aws_iam_policy.team_crud.arn
}
