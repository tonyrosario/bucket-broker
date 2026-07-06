# ---------------------------------------------------------------------------
# Step Functions state machine — the provisioning orchestrator.
#
# Flow:
#   RenderAndValidate  (glue Lambda) validates the request, renders JSON tfvars,
#                      and writes the idempotent PENDING -> PROVISIONING update.
#   RunCodeBuild       codebuild:startBuild.sync — terraform apply of golden-bucket
#                      under the per-request ABAC session. Bounded by the task
#                      timeout; the project's concurrent_build_limit bounds fan-out.
#   SetReady           status -> READY, guarded by status = PROVISIONING.
#   On ANY error       -> SendToDLQ (SQS) -> SetFailed (status -> FAILED) -> Fail.
#
# 10-minute SLO: the top-level TimeoutSeconds hard-caps every execution at
# var.execution_timeout_seconds (default 600). The RunCodeBuild task timeout sits
# below it, leaving headroom for the terminal status write. A breach also trips
# the ExecutionTime alarm (logs.tf).
#
# Idempotent re-runs: the request-handler starts executions with name=requestId
# (StartExecution dedups), the glue's PROVISIONING write is conditional, and each
# terminal write below carries a ConditionExpression so a replay cannot regress a
# terminal record. terraform apply itself is declaratively idempotent.
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "provisioner" {
  name     = "${local.prefix}-provisioner"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"

  #checkov:skip=CKV_AWS_285:Execution-history logging IS enabled via logging_configuration (level=ERROR) below; checkov does not detect the nested attribute. ERROR level captures failures without persisting execution data (which may contain request detail).
  #checkov:skip=CKV_AWS_284:Logging IS enabled via logging_configuration below; checkov may not recognise the nested attribute.

  logging_configuration {
    level                  = "ERROR"
    include_execution_data = false
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment        = "bucket-broker provisioner: PENDING -> PROVISIONING -> READY/FAILED, 10-min SLO"
    StartAt        = "RenderAndValidate"
    TimeoutSeconds = var.execution_timeout_seconds

    States = {
      RenderAndValidate = {
        Type       = "Task"
        Resource   = "arn:${local.partition}:states:::lambda:invoke"
        ResultPath = "$.render"
        Parameters = {
          FunctionName = aws_lambda_function.glue.arn
          "Payload.$"  = "$"
        }
        ResultSelector = {
          "bucketName.$"    = "$.Payload.bucketName"
          "team.$"          = "$.Payload.team"
          "requestId.$"     = "$.Payload.requestId"
          "correlationId.$" = "$.Payload.correlationId"
          "stateKey.$"      = "$.Payload.stateKey"
          "tfvarsJson.$"    = "$.Payload.tfvarsJson"
        }
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
          IntervalSeconds = 2
          MaxAttempts     = 3
          BackoffRate     = 2.0
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "SendToDLQ"
          ResultPath  = "$.error"
        }]
        Next = "RunCodeBuild"
      }

      RunCodeBuild = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::codebuild:startBuild.sync"
        Parameters = {
          ProjectName = aws_codebuild_project.terraform_runner.name
          EnvironmentVariablesOverride = [
            { Name = "BUCKET_NAME", "Value.$" = "$.render.bucketName", Type = "PLAINTEXT" },
            { Name = "TEAM", "Value.$" = "$.render.team", Type = "PLAINTEXT" },
            { Name = "REQUEST_ID", "Value.$" = "$.render.requestId", Type = "PLAINTEXT" },
            { Name = "CORRELATION_ID", "Value.$" = "$.render.correlationId", Type = "PLAINTEXT" },
            { Name = "STATE_KEY", "Value.$" = "$.render.stateKey", Type = "PLAINTEXT" },
            { Name = "TFVARS_JSON", "Value.$" = "$.render.tfvarsJson", Type = "PLAINTEXT" },
          ]
        }
        TimeoutSeconds = var.codebuild_task_timeout_seconds
        ResultPath     = "$.codebuild"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "SendToDLQ"
          ResultPath  = "$.error"
        }]
        Next = "SetReady"
      }

      SetReady = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::dynamodb:updateItem"
        Parameters = {
          TableName                = aws_dynamodb_table.status.name
          Key                      = { requestId = { "S.$" = "$.requestId" } }
          UpdateExpression         = "SET #s = :ready, completedAt = :ts"
          ConditionExpression      = "attribute_exists(requestId) AND #s = :provisioning"
          ExpressionAttributeNames = { "#s" = "status" }
          ExpressionAttributeValues = {
            ":ready"        = { S = "READY" }
            ":provisioning" = { S = "PROVISIONING" }
            ":ts"           = { "S.$" = "$$.State.EnteredTime" }
          }
        }
        ResultPath = null
        Next       = "Succeed"
      }

      SendToDLQ = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::sqs:sendMessage"
        Parameters = {
          QueueUrl        = aws_sqs_queue.dlq.url
          "MessageBody.$" = "States.JsonToString($)"
        }
        ResultPath = null
        Next       = "SetFailed"
      }

      SetFailed = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::dynamodb:updateItem"
        Parameters = {
          TableName                = aws_dynamodb_table.status.name
          Key                      = { requestId = { "S.$" = "$.requestId" } }
          UpdateExpression         = "SET #s = :failed, failedAt = :ts"
          ConditionExpression      = "attribute_exists(requestId) AND #s <> :ready"
          ExpressionAttributeNames = { "#s" = "status" }
          ExpressionAttributeValues = {
            ":failed" = { S = "FAILED" }
            ":ready"  = { S = "READY" }
            ":ts"     = { "S.$" = "$$.State.EnteredTime" }
          }
        }
        ResultPath = null
        Next       = "Fail"
      }

      Succeed = { Type = "Succeed" }

      Fail = {
        Type  = "Fail"
        Error = "ProvisioningFailed"
        Cause = "Provisioning failed, timed out, or exceeded the 10-minute SLO. See the DLQ message and status=FAILED record."
      }
    }
  })

  depends_on = [aws_cloudwatch_log_group.sfn]
}
