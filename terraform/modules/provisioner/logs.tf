# ---------------------------------------------------------------------------
# CloudWatch log groups (KMS-encrypted, retention per var.log_retention_days)
# and the DLQ-depth alarm that enforces "failures -> alert" (ADR-0001).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/states/${local.prefix}-provisioner"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${local.prefix}-terraform-runner"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "glue" {
  name              = "/aws/lambda/${local.prefix}-render-tfvars"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

# ---------------------------------------------------------------------------
# DLQ depth alarm — any message on the DLQ means a provision failed.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.prefix}-provisioner-dlq-not-empty"
  alarm_description   = "One or more provisioning executions failed and landed on the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = var.alarm_sns_topic_arns
  ok_actions    = var.alarm_sns_topic_arns

  tags = local.tags
}

# ---------------------------------------------------------------------------
# SLO alarm — a Step Functions execution running longer than the SLO budget
# indicates the 10-minute target is at risk. ExecutionTime is emitted on
# completion; the execution timeout (state_machine.tf) hard-caps it regardless.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "slo_breach" {
  alarm_name          = "${local.prefix}-provisioner-slo-breach"
  alarm_description   = "A provisioning execution exceeded the ${var.execution_timeout_seconds}s (10-minute) SLO budget."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExecutionTime"
  namespace           = "AWS/States"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.execution_timeout_seconds * 1000 # metric is milliseconds
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.provisioner.arn
  }

  alarm_actions = var.alarm_sns_topic_arns
  ok_actions    = var.alarm_sns_topic_arns

  tags = local.tags
}
