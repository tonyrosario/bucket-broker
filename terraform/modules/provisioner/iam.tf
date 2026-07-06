# ---------------------------------------------------------------------------
# IAM — four roles, each least-privilege for exactly the operations it performs.
#
#   glue         (Lambda)     — logs + the single PROVISIONING status write.
#   sfn          (States)     — orchestration only (invoke/build/update/dlq).
#   codebuild    (CodeBuild)  — MINIMAL: logs + assume the provisioning role.
#   provisioning (assumed)    — the terraform execution identity. ABAC-scoped by
#                               BucketName/Team/RequestId SESSION TAGS so every
#                               grant resolves to the EXACT per-request resource
#                               (no account-wide `name-*` prefix — #16 iac-4).
#
# The runner NEVER holds resource-create or state permissions directly; it can
# only assume the provisioning role, passing validated session tags. Because the
# CodeBuild source is pinned to an immutable SHA (codebuild.tf) the buildspec
# that performs the tagged assume-role cannot be swapped (#16 delivery-vector).
# ---------------------------------------------------------------------------

# ===========================================================================
# glue Lambda role
# ===========================================================================

resource "aws_iam_role" "glue" {
  name        = "${local.prefix}-render-tfvars"
  description = "Execution role for the provisioner glue (render/validate/set-PROVISIONING) Lambda."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.prefix}-render-tfvars" }
        StringEquals = { "aws:SourceAccount" = local.account_id }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "glue" {
  name = "${local.prefix}-render-tfvars"
  role = aws_iam_role.glue.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.glue.arn}:*"
      },
      {
        # The glue Lambda performs exactly one write: the idempotent
        # PENDING -> PROVISIONING transition (ConditionExpression enforced by the
        # handler). UpdateItem only; no Put/Delete/Scan on the status table.
        Sid      = "StatusProvisioningWrite"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.status.arn
      },
      {
        Sid      = "KMSForStatusTable"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
        Resource = aws_kms_key.data.arn
      },
    ]
  })
}

# ===========================================================================
# Step Functions execution role
# ===========================================================================

resource "aws_iam_role" "sfn" {
  name        = "${local.prefix}-sfn-provisioner"
  description = "Execution role for the provisioner Step Functions state machine."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:states:${local.region}:${local.account_id}:stateMachine:${local.prefix}-provisioner" }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "sfn" {
  name = "${local.prefix}-sfn-provisioner"
  role = aws_iam_role.sfn.id

  #checkov:skip=CKV_AWS_355:The logs:* delivery actions for Step Functions vended logging require Resource "*" — CloudWatch Logs delivery is not resource-scopable. Scoped everywhere else.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeGlueLambda"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.glue.arn
      },
      {
        Sid      = "RunTerraformRunner"
        Effect   = "Allow"
        Action   = ["codebuild:StartBuild", "codebuild:StopBuild", "codebuild:BatchGetBuilds"]
        Resource = aws_codebuild_project.terraform_runner.arn
      },
      {
        # Required by the codebuild:startBuild.sync service integration.
        Sid      = "EventBridgeForCodeBuildSync"
        Effect   = "Allow"
        Action   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
        Resource = "arn:${local.partition}:events:${local.region}:${local.account_id}:rule/StepFunctionsGetEventsForCodeBuildStartBuildRule"
      },
      {
        # Terminal status writes (READY / FAILED). UpdateItem only; each write is
        # guarded by a ConditionExpression in the state machine for idempotency.
        Sid      = "StatusTerminalWrite"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.status.arn
      },
      {
        Sid      = "KMSForStatusTable"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
        Resource = aws_kms_key.data.arn
      },
      {
        Sid      = "SendToDLQ"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.dlq.arn
      },
      {
        Sid    = "StepFunctionsVendedLogging"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
        ]
        Resource = "*" # tfsec:ignore:aws-iam-no-policy-wildcards CloudWatch Logs delivery API is not resource-scopable.
      },
    ]
  })
}

# ===========================================================================
# CodeBuild runner role — MINIMAL (logs + assume the provisioning role)
# ===========================================================================

resource "aws_iam_role" "codebuild" {
  name        = "${local.prefix}-codebuild-runner"
  description = "CodeBuild Terraform-runner service role. Holds NO state or resource-create permissions; it can only assume the provisioning role with validated session tags."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:codebuild:${local.region}:${local.account_id}:project/${local.prefix}-terraform-runner" }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${local.prefix}-codebuild-runner"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CodeBuildLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.codebuild.arn}:*"
      },
      {
        # The ONLY elevation the runner has: assume the provisioning role. All
        # state + resource-create permissions live on that role and resolve to
        # the exact per-request resource via the session tags passed here.
        Sid      = "AssumeProvisioningRole"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = aws_iam_role.provisioning.arn
      },
    ]
  })
}

# ===========================================================================
# Provisioning role — the terraform execution identity (ABAC via session tags)
# ===========================================================================

resource "aws_iam_role" "provisioning" {
  name        = "${local.prefix}-provisioning"
  description = "Terraform execution identity, assumed by the CodeBuild runner with BucketName/Team/RequestId session tags. Every permission is ABAC-scoped to the exact per-request resource."

  # Trust: only the runner role may assume, and only while passing session tags
  # whose BucketName matches the platform prefix — bounding the ABAC namespace so
  # the runner can never target a pre-existing bucket outside `<prefix>*`.
  #
  # Team and RequestId are ALSO constrained (previously "*"): they build IAM
  # role/policy ARNs and the state-object prefix, so an unconstrained value both
  # amplified the CreateRole path and let a request scope another request's state
  # prefix. IAM's StringLike/StringNotLike wildcards are only `*`/`?` (a literal
  # `*` in a value can't be pattern-matched, but note a substituted policy
  # variable is inserted LITERALLY and is never re-interpreted as a wildcard):
  #   - Team:      must be non-empty and free of `/ : , space` (which would
  #                distort the derived role/policy ARNs).
  #   - RequestId: pinned to the 8-4-4-4-12 UUID layout the request-handler emits
  #                (each `?` = exactly one char), forbidding path/colon injection
  #                by construction of length + dash positions.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.codebuild.arn }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Condition = {
        StringLike = {
          "aws:RequestTag/BucketName" = "${var.provisioned_bucket_prefix}*"
          "aws:RequestTag/Team"       = "?*"
          "aws:RequestTag/RequestId"  = "????????-????-????-????-????????????"
        }
        StringNotLike = {
          "aws:RequestTag/Team" = ["*/*", "*:*", "*,*", "* *"]
        }
      }
    }]

    # Reject a cross-account broker principal (#9 iac-3 / ADR-0001 in-account
    # design): every broker ARN rendered into golden-bucket's trusted_principals
    # must belong to the deploying account.
  })

  lifecycle {
    precondition {
      condition     = alltrue([for a in var.broker_principal_arns : can(regex("^arn:${local.partition}:iam::${local.account_id}:", a))])
      error_message = "broker_principal_arns must all belong to the deploying account ${local.account_id} (cross-account brokers are rejected per ADR-0001)."
    }
  }

  tags = local.tags
}

resource "aws_iam_role_policy" "provisioning" {
  name = "${local.prefix}-provisioning"
  role = aws_iam_role.provisioning.id

  # tfsec:ignore:aws-iam-no-policy-wildcards — every wildcard below is either
  # (a) required by the AWS API (kms:CreateKey cannot name a not-yet-created
  # key), or (b) an ABAC policy variable ($${aws:PrincipalTag/...}) / resource-tag
  # condition that resolves to the EXACT per-request resource. See per-Sid notes.
  #checkov:skip=CKV_AWS_355:kms:CreateKey and tag/alias operations on not-yet-created keys cannot be named; they are constrained by kms:KeyUsage, aws:RequestTag, and per-request aws:ResourceTag conditions.
  #checkov:skip=CKV_AWS_290:Write actions are ABAC-scoped to the exact per-request resource via BucketName/Team/RequestId session tags; there is no unrestricted write.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # --------------------------------------------------------------------
      # EXPLICIT DENY — platform keys are OFF LIMITS (#18 P0-1).
      #
      # The golden-bucket key grants below (TagProvisionKeyAtCreate /
      # UseProvisionKey) are scoped to key/* gated on a self-writable Name tag.
      # Because the module data/logs key policies delegate to IAM via
      # `root: kms:*`, a session could otherwise tag one of THOSE keys with the
      # magic Name and then decrypt it — reaching the data/logs keys and (with no
      # ViaService on UseProvisionKey) gaining DIRECT kms:Decrypt on the state
      # CMK, nullifying StateKMSViaService. An explicit Deny overrides any Allow
      # regardless of tags, so these two statements provably close that path
      # while leaving the per-request golden-bucket key (a different ARN) usable.
      # --------------------------------------------------------------------
      {
        # data + logs keys: no runner access under ANY condition. The runner
        # never legitimately touches these (they encrypt the status table, DLQ,
        # Lambda env, and log groups — all handled by the glue/sfn roles).
        Sid      = "DenyPlatformDataLogsKeys"
        Effect   = "Deny"
        Action   = ["kms:*"]
        Resource = [aws_kms_key.data.arn, aws_kms_key.logs.arn]
      },
      {
        # state CMK: deny every DIRECT KMS API call (kms:ViaService absent). The
        # only legitimate use is THROUGH s3/dynamodb, where AWS sets ViaService —
        # that path stays allowed by StateKMSViaService below. This overrides the
        # tag-based UseProvisionKey Allow (which carries no ViaService), so a
        # tagged state key still cannot be decrypted out-of-band (#9 iac-1).
        Sid      = "DenyDirectStateKeyKMS"
        Effect   = "Deny"
        Action   = ["kms:*"]
        Resource = var.state_kms_key_arn
        Condition = {
          Null = { "kms:ViaService" = "true" }
        }
      },
      # --------------------------------------------------------------------
      # State backend — scoped to THIS request's state key prefix only.
      # --------------------------------------------------------------------
      {
        Sid      = "StateObjectAccess"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${var.state_bucket_arn}/${local.state_key_prefix}/$${aws:PrincipalTag/RequestId}/*"
      },
      {
        Sid      = "StateBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.state_bucket_arn
        Condition = {
          StringLike = { "s3:prefix" = "${local.state_key_prefix}/$${aws:PrincipalTag/RequestId}/*" }
        }
      },
      {
        # Exactly the state-locking action set (acquire/read/release). No
        # Query/Scan/UpdateItem — that would be beyond what the backend needs.
        Sid      = "StateLock"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = var.lock_table_arn
      },
      {
        # State CMK — usable ONLY through S3 and DynamoDB, in-account. A leaked
        # runner credential cannot Decrypt an exfiltrated state blob via the KMS
        # API directly (#9 iac-1). The runner never needs a separate data key.
        Sid      = "StateKMSViaService"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
        Resource = var.state_kms_key_arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          "ForAnyValue:StringEquals" = {
            "kms:ViaService" = local.state_kms_via_services
          }
        }
      },
      # --------------------------------------------------------------------
      # golden-bucket S3 buckets — EXACT per-request names via BucketName tag.
      # --------------------------------------------------------------------
      {
        Sid    = "ProvisionBuckets"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket", "s3:DeleteBucket", "s3:GetBucketLocation",
          "s3:ListBucket", "s3:PutBucketPolicy", "s3:GetBucketPolicy", "s3:DeleteBucketPolicy",
          "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration",
          "s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock",
          "s3:PutBucketVersioning", "s3:GetBucketVersioning",
          "s3:PutBucketLogging", "s3:GetBucketLogging",
          "s3:PutLifecycleConfiguration", "s3:GetLifecycleConfiguration",
          "s3:PutBucketOwnershipControls", "s3:GetBucketOwnershipControls",
          "s3:PutBucketTagging", "s3:GetBucketTagging",
          "s3:PutBucketAcl", "s3:GetBucketAcl",
        ]
        Resource = [
          "arn:${local.partition}:s3:::$${aws:PrincipalTag/BucketName}",
          "arn:${local.partition}:s3:::$${aws:PrincipalTag/BucketName}-access-logs",
        ]
      },
      # --------------------------------------------------------------------
      # golden-bucket CMK — create, then use/alias bound to THIS request's key
      # by the per-request Name tag (golden-bucket tags its key
      # Name=golden-bucket-<bucketName>). Never the universal Module tag; never
      # kms:PutKeyPolicy or kms:ScheduleKeyDeletion (#16 P0).
      # --------------------------------------------------------------------
      {
        Sid      = "CreateProvisionKey"
        Effect   = "Allow"
        Action   = ["kms:CreateKey"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:KeyUsage" = "ENCRYPT_DECRYPT" }
        }
      },
      {
        Sid      = "TagProvisionKeyAtCreate"
        Effect   = "Allow"
        Action   = ["kms:TagResource"]
        Resource = "arn:${local.partition}:kms:${local.region}:${local.account_id}:key/*"
        Condition = {
          StringEquals = { "aws:RequestTag/Name" = "golden-bucket-$${aws:PrincipalTag/BucketName}" }
        }
      },
      {
        Sid    = "UseProvisionKey"
        Effect = "Allow"
        Action = [
          "kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus",
          "kms:EnableKeyRotation", "kms:ListResourceTags",
          "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:ReEncrypt*",
        ]
        Resource = "arn:${local.partition}:kms:${local.region}:${local.account_id}:key/*"
        Condition = {
          StringEquals = { "aws:ResourceTag/Name" = "golden-bucket-$${aws:PrincipalTag/BucketName}" }
        }
      },
      {
        Sid      = "ProvisionKeyAliasOnAlias"
        Effect   = "Allow"
        Action   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
        Resource = "arn:${local.partition}:kms:${local.region}:${local.account_id}:alias/golden-bucket-$${aws:PrincipalTag/BucketName}"
      },
      {
        # The key half of the alias authorization — bound to the just-created
        # key via its per-request Name tag (never key/* unconditionally).
        Sid      = "ProvisionKeyAliasOnKey"
        Effect   = "Allow"
        Action   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
        Resource = "arn:${local.partition}:kms:${local.region}:${local.account_id}:key/*"
        Condition = {
          StringEquals = { "aws:ResourceTag/Name" = "golden-bucket-$${aws:PrincipalTag/BucketName}" }
        }
      },
      # --------------------------------------------------------------------
      # golden-bucket team IAM role + policy — EXACT names via Team+BucketName.
      # --------------------------------------------------------------------
      {
        # CreateRole is split out and REQUIRES the platform team-role permissions
        # boundary (#18 P0-2): even if a compromised session attaches an
        # over-broad policy (or picks an attacker trust doc), the boundary caps
        # the resulting role to at most the golden-bucket CRUD surface — it can
        # never become an account admin. The runner is NOT granted
        # iam:PutRolePermissionsBoundary/DeleteRolePermissionsBoundary, so the
        # boundary can't be stripped after creation.
        Sid      = "CreateTeamRoleWithBoundary"
        Effect   = "Allow"
        Action   = ["iam:CreateRole"]
        Resource = "arn:${local.partition}:iam::${local.account_id}:role/golden-bucket-$${aws:PrincipalTag/Team}-$${aws:PrincipalTag/BucketName}"
        Condition = {
          StringEquals = {
            "iam:PermissionsBoundary" = aws_iam_policy.team_role_boundary.arn
          }
        }
      },
      {
        # Non-create lifecycle actions on the exact team role. These calls do not
        # carry iam:PermissionsBoundary, so they live in a separate statement.
        Sid    = "ManageTeamRole"
        Effect = "Allow"
        Action = [
          "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole",
          "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
        ]
        Resource = "arn:${local.partition}:iam::${local.account_id}:role/golden-bucket-$${aws:PrincipalTag/Team}-$${aws:PrincipalTag/BucketName}"
      },
      {
        # The per-request crud policy is created FRESH each request and never
        # versioned, so iam:CreatePolicyVersion is intentionally omitted (#18
        # P0-2): granting it would let a session swap an {Allow *:*} document into
        # the pinned crud ARN, defeating AttachTeamPolicyOnly's ARN pin.
        Sid    = "ProvisionTeamPolicy"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy", "iam:GetPolicyVersion",
          "iam:ListPolicyVersions", "iam:DeletePolicyVersion",
          "iam:TagPolicy", "iam:UntagPolicy",
        ]
        Resource = "arn:${local.partition}:iam::${local.account_id}:policy/golden-bucket-crud-$${aws:PrincipalTag/Team}-$${aws:PrincipalTag/BucketName}"
      },
      {
        # Attach ONLY the team's own CRUD policy to the team role — the
        # iam:PolicyARN condition blocks attaching any other managed policy
        # (e.g. AdministratorAccess), closing the privilege-escalation path.
        Sid      = "AttachTeamPolicyOnly"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = "arn:${local.partition}:iam::${local.account_id}:role/golden-bucket-$${aws:PrincipalTag/Team}-$${aws:PrincipalTag/BucketName}"
        Condition = {
          ArnEquals = {
            "iam:PolicyARN" = "arn:${local.partition}:iam::${local.account_id}:policy/golden-bucket-crud-$${aws:PrincipalTag/Team}-$${aws:PrincipalTag/BucketName}"
          }
        }
      },
    ]
  })
}

# ===========================================================================
# Team-role permissions boundary (#18 P0-2)
#
# This managed policy is the CEILING for EVERY IAM role the provisioning session
# creates (enforced by the iam:PermissionsBoundary condition on CreateTeamRoleWithBoundary
# above). A role's effective permissions are the INTERSECTION of its attached
# policies and this boundary — so even if a compromised session attaches
# AdministratorAccess, the team role can do no more than S3 data-plane on the
# platform bucket namespace + KMS strictly via S3. It grants nothing on its own
# (a boundary is a bound, not a grant); it exists only to cap.
#
# It is sized to permit EXACTLY what golden-bucket's team CRUD policy needs
# (golden-bucket/iam.tf: S3 object+bucket actions on the bucket ARN, and
# kms:GenerateDataKey/Decrypt/DescribeKey via s3), plus headroom, so legitimate
# provisioning is unaffected.
# ===========================================================================
resource "aws_iam_policy" "team_role_boundary" {
  name        = "${local.prefix}-team-role-boundary"
  description = "Permissions boundary capping any golden-bucket team role the provisioning session creates to S3 data-plane on the platform namespace + KMS-via-S3. Prevents CreateRole -> admin privilege escalation (#18 P0-2)."

  #checkov:skip=CKV_AWS_290:This is a permissions BOUNDARY (a ceiling that grants nothing on its own); the object-path and via-service KMS scopes are the intended maximum surface. Per-request bucket/key names are unknown at module-apply time.
  #checkov:skip=CKV_AWS_355:KMS use is capped by kms:ViaService=s3 (region-pinned); individual per-request key ARNs cannot be named because they are created per request.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Cap: S3 data-plane, scoped to the platform bucket namespace only. Covers
        # exactly the golden-bucket team_crud action set (data + access-logs
        # buckets both fall under the prefix). No bucket-policy / delete-bucket /
        # IAM / cross-service actions are permitted through the boundary.
        Sid    = "CapS3DataPlaneWithinNamespace"
        Effect = "Allow"
        Action = [
          "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging", "s3:GetObjectVersionTagging",
          "s3:ListMultipartUploadParts", "s3:PutObject", "s3:PutObjectTagging",
          "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload",
          "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation",
        ]
        Resource = [ #tfsec:ignore:aws-iam-no-policy-wildcards
          "arn:${local.partition}:s3:::${var.provisioned_bucket_prefix}*",
          "arn:${local.partition}:s3:::${var.provisioned_bucket_prefix}*/*",
        ]
      },
      {
        # Cap: KMS usable ONLY through S3 in this region. A boundaried team role
        # can never call KMS directly, and never for a non-S3 service.
        Sid      = "CapKMSViaS3Only"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:ReEncrypt*"]
        Resource = "*" #tfsec:ignore:aws-iam-no-policy-wildcards
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${local.region}.amazonaws.com" }
        }
      },
    ]
  })

  tags = local.tags
}
