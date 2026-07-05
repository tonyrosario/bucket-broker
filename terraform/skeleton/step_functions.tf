# ---------------------------------------------------------------------------
# Step Functions state machine — skeleton provisioner.
#
# Status lifecycle:  Lambda writes PENDING on StartExecution.
#   SetProvisioning  → DynamoDB UpdateItem (status=PROVISIONING)
#   RunCodeBuild     → CodeBuild StartBuild.sync (terraform on stripped-bucket)
#   SetReady         → DynamoDB UpdateItem (status=READY)
#   On any error:
#     SendToDLQ      → SQS SendMessage (DLQ)
#     SetFailed      → DynamoDB UpdateItem (status=FAILED)
#
# SLO guard: TimeoutSeconds=600 (10 minutes) on the execution.
# CodeBuild task timeout: 540 s (9 min) leaves 60 s headroom for status writes.
#
# These values must match src/skeleton/src/constants.ts:
#   SLO_TIMEOUT_SECONDS           = 600
#   CODEBUILD_TASK_TIMEOUT_SECONDS = 540
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "provisioner" {
  name     = "${local.prefix}-provisioner"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"

  #checkov:skip=CKV_AWS_285:Logging IS enabled via logging_configuration below with level=ERROR; checkov may not recognise the nested attribute.
  #checkov:skip=CKV_AWS_284:Logging IS enabled via logging_configuration below; checkov may not recognise the nested attribute in all versions.

  logging_configuration {
    level                  = "ERROR"
    include_execution_data = false
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
  }

  definition = jsonencode({
    Comment        = "Skeleton provisioner: PENDING→PROVISIONING→READY/FAILED with 10-min SLO guard"
    StartAt        = "SetProvisioning"
    TimeoutSeconds = 600

    States = {
      SetProvisioning = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.requests.name
          Key = {
            requestId = { "S.$" = "$.requestId" }
          }
          UpdateExpression         = "SET #s = :status, updatedAt = :ts"
          ExpressionAttributeNames = { "#s" = "status" }
          ExpressionAttributeValues = {
            ":status" = { S = "PROVISIONING" }
            ":ts"     = { "S.$" = "$$.Execution.StartTime" }
          }
        }
        ResultPath = null
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "SendToDLQ"
            ResultPath  = "$.error"
          }
        ]
        Next = "RunCodeBuild"
      }

      RunCodeBuild = {
        Type     = "Task"
        Resource = "arn:aws:states:::codebuild:startBuild.sync"
        Parameters = {
          ProjectName = aws_codebuild_project.terraform_runner.name
          EnvironmentVariablesOverride = [
            {
              Name      = "REQUEST_ID"
              "Value.$" = "$.requestId"
              Type      = "PLAINTEXT"
            },
            {
              Name      = "CORRELATION_ID"
              "Value.$" = "$.correlationId"
              Type      = "PLAINTEXT"
            }
          ]
        }
        TimeoutSeconds = 540
        ResultPath     = "$.codebuildResult"
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "SendToDLQ"
            ResultPath  = "$.error"
          }
        ]
        Next = "SetReady"
      }

      SetReady = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.requests.name
          Key = {
            requestId = { "S.$" = "$.requestId" }
          }
          UpdateExpression         = "SET #s = :status, completedAt = :ts"
          ExpressionAttributeNames = { "#s" = "status" }
          ExpressionAttributeValues = {
            ":status" = { S = "READY" }
            ":ts"     = { "S.$" = "$$.State.EnteredTime" }
          }
        }
        ResultPath = null
        Next       = "Succeed"
      }

      SendToDLQ = {
        Type     = "Task"
        Resource = "arn:aws:states:::sqs:sendMessage"
        Parameters = {
          QueueUrl        = aws_sqs_queue.dlq.url
          "MessageBody.$" = "States.JsonToString($)"
        }
        ResultPath = null
        Next       = "SetFailed"
      }

      SetFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.requests.name
          Key = {
            requestId = { "S.$" = "$.requestId" }
          }
          UpdateExpression         = "SET #s = :status, failedAt = :ts"
          ExpressionAttributeNames = { "#s" = "status" }
          ExpressionAttributeValues = {
            ":status" = { S = "FAILED" }
            ":ts"     = { "S.$" = "$$.State.EnteredTime" }
          }
        }
        ResultPath = null
        Next       = "Fail"
      }

      Succeed = {
        Type = "Succeed"
      }

      Fail = {
        Type  = "Fail"
        Error = "ProvisioningFailed"
        Cause = "CodeBuild job failed, timed out, or exceeded the 10-minute SLO."
      }
    }
  })

  depends_on = [aws_cloudwatch_log_group.sfn]
}
