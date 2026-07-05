# ---------------------------------------------------------------------------
# IAM roles and policies for the skeleton module.
#
# Least-privilege principle applied throughout:
# - Each role/Lambda has its own policy with only the actions it needs.
# - Resource ARNs are fully specified where known.
# - Service trust policies use aws:SourceArn / aws:SourceAccount conditions.
# - No Action:"*" or Resource:"*" except where AWS requires it (kms:CreateKey).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Lambda: post-buckets
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda_post_buckets" {
  name        = "${local.prefix}-lambda-post-buckets"
  description = "Execution role for the skeleton post-buckets Lambda."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-post-buckets"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_post_buckets" {
  name = "skeleton-post-buckets-policy"
  role = aws_iam_role.lambda_post_buckets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.lambda_post_buckets.arn}:*"
      },
      {
        Sid      = "DynamoDBWriteRequest"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.requests.arn
      },
      {
        Sid      = "StartSFNExecution"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = aws_sfn_state_machine.provisioner.arn
      },
      {
        Sid    = "KMSForDynamoDB"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.data.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda: get-bucket
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda_get_bucket" {
  name        = "${local.prefix}-lambda-get-bucket"
  description = "Execution role for the skeleton get-bucket Lambda."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-get-bucket"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_get_bucket" {
  name = "skeleton-get-bucket-policy"
  role = aws_iam_role.lambda_get_bucket.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.lambda_get_bucket.arn}:*"
      },
      {
        Sid      = "DynamoDBReadRequest"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.requests.arn
      },
      {
        Sid    = "KMSForDynamoDB"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.data.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Step Functions execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "sfn" {
  name        = "${local.prefix}-sfn-provisioner"
  description = "Execution role for the skeleton Step Functions provisioner."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "states.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.prefix}-provisioner"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "sfn" {
  name = "skeleton-sfn-provisioner-policy"
  role = aws_iam_role.sfn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # DynamoDB SDK integration — update request status
      {
        Sid      = "DynamoDBUpdateStatus"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.requests.arn
      },
      {
        Sid    = "KMSForDynamoDB"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.data.arn
      },
      # CodeBuild StartBuild.sync integration
      {
        Sid    = "CodeBuildStartBuild"
        Effect = "Allow"
        Action = [
          "codebuild:StartBuild",
          "codebuild:StopBuild",
          "codebuild:BatchGetBuilds"
        ]
        Resource = aws_codebuild_project.terraform_runner.arn
      },
      # EventBridge rules needed by the StartBuild.sync integration
      {
        Sid    = "EventBridgeForSync"
        Effect = "Allow"
        Action = [
          "events:PutTargets",
          "events:PutRule",
          "events:DescribeRule"
        ]
        Resource = "arn:aws:events:${local.region}:${local.account_id}:rule/StepFunctionsGetEventsForCodeBuildStartBuildRule"
      },
      # SQS SDK integration — send message to DLQ on failure
      {
        Sid      = "SQSSendToDLQ"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.dlq.arn
      },
      {
        Sid    = "KMSForSQS"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.data.arn
      },
      # CloudWatch Logs for Step Functions execution logging
      {
        Sid    = "SFNLogging"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups"
        ]
        Resource = "*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# CodeBuild execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "codebuild" {
  name        = "${local.prefix}-codebuild-runner"
  description = "Execution role for the skeleton CodeBuild Terraform runner."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "codebuild.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:codebuild:${local.region}:${local.account_id}:project/${local.prefix}-terraform-runner"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "skeleton-codebuild-runner-policy"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch Logs for build output
      {
        Sid    = "CodeBuildLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.codebuild.arn}:*"
      },
      # TF state bucket access — scoped to the specific bucket
      {
        Sid    = "TFStateBucketAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.tfstate.arn}/*"
      },
      {
        Sid      = "TFStateBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.tfstate.arn
      },
      {
        Sid    = "KMSForTFState"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.tfstate.arn
      },
      # TF state DynamoDB lock table
      {
        Sid    = "TFStateLockTable"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem"
        ]
        Resource = aws_dynamodb_table.tfstate_lock.arn
      },
      {
        Sid    = "KMSForLockTable"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.data.arn
      },
      # Stripped-bucket provisioning — scoped to skeleton-prefixed bucket names
      {
        Sid    = "ProvisionStrippedBucket"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:PutBucketEncryption",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutEncryptionConfiguration",
          "s3:GetBucketEncryption",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketTagging",
          "s3:PutBucketTagging",
          "s3:ListBucket"
        ]
        Resource = "arn:aws:s3:::${local.prefix}-*"
      },
      # KMS key creation for the stripped bucket.
      # kms:CreateKey cannot be scoped to a specific resource ARN (key doesn't
      # exist yet), so it is Resource:"*" — restricted by the RequestedKeyUsage
      # condition to ENCRYPT_DECRYPT only.
      {
        Sid      = "CreateStrippedBucketKMSKey"
        Effect   = "Allow"
        Action   = ["kms:CreateKey"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:KeyUsage" = "ENCRYPT_DECRYPT"
          }
        }
      },
      {
        Sid    = "ManageStrippedBucketKMSAlias"
        Effect = "Allow"
        Action = [
          "kms:CreateAlias",
          "kms:DeleteAlias"
        ]
        # Alias resource ARN — scoped to skeleton prefix
        Resource = [
          "arn:aws:kms:${local.region}:${local.account_id}:alias/${local.prefix}-bucket-*",
          # The key ARN is unknown until CreateKey returns — allow on * for key ARNs
          # but alias operations already narrow the blast radius via alias name.
          "arn:aws:kms:${local.region}:${local.account_id}:key/*"
        ]
      },
      {
        # Scoped to per-request stripped-bucket keys via a distinguishing
        # Purpose tag that the platform keys (data/logs/tfstate) never carry.
        # The universal `Module = skeleton` tag (provider default_tags) is NOT
        # usable here — it also matches the platform keys. kms:PutKeyPolicy and
        # kms:ScheduleKeyDeletion are intentionally NOT granted: CreateKey sets
        # the policy at creation, and the runner must never rewrite or delete a
        # platform key. (#16 review P0)
        Sid    = "UseStrippedBucketKMSKey"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
          "kms:EnableKeyRotation",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus"
        ]
        Resource = "arn:aws:kms:${local.region}:${local.account_id}:key/*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Purpose" = "stripped-bucket"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# API Gateway CloudWatch role (one per account/region, idempotent)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "apigw_cloudwatch" {
  name        = "${local.prefix}-apigw-cloudwatch"
  description = "Allows API Gateway to write to CloudWatch Logs."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "apigateway.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  role       = aws_iam_role.apigw_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "skeleton" {
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch.arn
}
