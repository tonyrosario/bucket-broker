# ---------------------------------------------------------------------------
# Dead-letter queue — receives the execution context of any failed provision
# before Step Functions writes status=FAILED. Retains 14 days for triage.
# A CloudWatch alarm (logs.tf) fires on depth > 0.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.prefix}-provisioner-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 300
  kms_master_key_id          = aws_kms_key.data.arn

  tags = local.tags
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSFNSendMessage"
        Effect    = "Allow"
        Principal = { Service = "states.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.dlq.arn
        Condition = {
          ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:states:${local.region}:${local.account_id}:stateMachine:${local.prefix}-provisioner" }
          StringEquals = { "aws:SourceAccount" = local.account_id }
        }
      },
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.dlq.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}
