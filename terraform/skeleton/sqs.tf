# ---------------------------------------------------------------------------
# SQS Dead-Letter Queue for failed Step Functions executions.
#
# Step Functions catches errors and sends a message here before writing
# FAILED status to DynamoDB.  The DLQ retains messages for 14 days for
# operational investigation.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.prefix}-provisioner-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 300
  kms_master_key_id          = aws_kms_key.data.arn

  # The DLQ itself does not need a DLQ — it is already the dead-letter
  # destination.  Messages that fail processing here are investigated
  # operationally (CloudWatch alarms will fire on queue depth > 0).
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowSFNSendMessage"
        Effect = "Allow"
        Principal = {
          Service = "states.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.dlq.arn
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.prefix}-provisioner"
          }
        }
      },
      {
        Sid    = "DenyNonHTTPS"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action   = "sqs:*"
        Resource = aws_sqs_queue.dlq.arn
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}
