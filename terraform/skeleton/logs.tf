# ---------------------------------------------------------------------------
# CloudWatch Log Groups (all skeleton log groups defined here).
# All groups: KMS-encrypted, 30-day retention.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda_post_buckets" {
  name              = "/aws/lambda/${local.prefix}-post-buckets"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "lambda_get_bucket" {
  name              = "/aws/lambda/${local.prefix}-get-bucket"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/states/${local.prefix}-provisioner"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${local.prefix}-terraform-runner"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "api_gw" {
  name              = "/aws/apigateway/${local.prefix}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

# ---------------------------------------------------------------------------
# CloudWatch alarm: DLQ depth > 0 indicates a provisioning failure.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.prefix}-provisioner-dlq-not-empty"
  alarm_description   = "One or more skeleton provisioning executions have failed and landed on the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  treat_missing_data = "notBreaching"
}
