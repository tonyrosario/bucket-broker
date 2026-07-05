# ---------------------------------------------------------------------------
# Lambda functions for the skeleton module.
#
# Handlers are packaged as inline dummy ZIPs for plan-only validation.
# In a live deploy the build step (npm run build) produces the real dist/.
# ---------------------------------------------------------------------------

# Inline dummy archive — Terraform validate requires a valid source.
# In a live deploy, replace with the compiled dist/ output from `npm run build`.
data "archive_file" "post_buckets" {
  type        = "zip"
  output_path = "${path.module}/dist/post-buckets.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

data "archive_file" "get_bucket" {
  type        = "zip"
  output_path = "${path.module}/dist/get-bucket.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

# ---------------------------------------------------------------------------
# post-buckets Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "post_buckets" { # tfsec:ignore:aws-lambda-enable-tracing
  #checkov:skip=CKV_AWS_50:X-Ray tracing deferred to observability module (#23); skeleton uses inline structured logging only.
  #checkov:skip=CKV_AWS_117:No VPC for skeleton Lambdas; VPC integration is not in scope for this tracer bullet.
  #checkov:skip=CKV_AWS_116:Lambda is invoked synchronously by API Gateway; DLQ is on the async Step Functions path, not the Lambda invocation path.
  #checkov:skip=CKV_AWS_115:Concurrent execution limit not set; skeleton operates at demo traffic levels where throttling is not a concern.
  #checkov:skip=CKV_AWS_272:Code-signing not required for skeleton tracer bullet; deferred to hardening milestone (#24).
  function_name    = "${local.prefix}-post-buckets"
  description      = "Skeleton: accepts POST /buckets, writes PENDING, starts Step Functions execution."
  role             = aws_iam_role.lambda_post_buckets.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.post_buckets.output_path
  source_code_hash = data.archive_file.post_buckets.output_base64sha256
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_mb

  environment {
    variables = {
      REQUESTS_TABLE    = aws_dynamodb_table.requests.name
      STATE_MACHINE_ARN = aws_sfn_state_machine.provisioner.arn
    }
  }

  # Encrypt environment variables at rest using the data KMS key.
  kms_key_arn = aws_kms_key.data.arn

  depends_on = [aws_cloudwatch_log_group.lambda_post_buckets]
}

# Lambda resource-based policy: only API Gateway can invoke this function.
resource "aws_lambda_permission" "apigw_post_buckets" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_buckets.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.skeleton.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# get-bucket Lambda
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "get_bucket" { # tfsec:ignore:aws-lambda-enable-tracing
  #checkov:skip=CKV_AWS_50:X-Ray tracing deferred to observability module (#23); skeleton uses inline structured logging only.
  #checkov:skip=CKV_AWS_117:No VPC for skeleton Lambdas; VPC integration is not in scope for this tracer bullet.
  #checkov:skip=CKV_AWS_116:Lambda is invoked synchronously by API Gateway; DLQ is on the async Step Functions path, not the Lambda invocation path.
  #checkov:skip=CKV_AWS_115:Concurrent execution limit not set; skeleton operates at demo traffic levels where throttling is not a concern.
  #checkov:skip=CKV_AWS_272:Code-signing not required for skeleton tracer bullet; deferred to hardening milestone (#24).
  function_name    = "${local.prefix}-get-bucket"
  description      = "Skeleton: handles GET /buckets/{id}, returns provision status from DynamoDB."
  role             = aws_iam_role.lambda_get_bucket.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.get_bucket.output_path
  source_code_hash = data.archive_file.get_bucket.output_base64sha256
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_mb

  environment {
    variables = {
      REQUESTS_TABLE = aws_dynamodb_table.requests.name
    }
  }

  # Encrypt environment variables at rest using the data KMS key.
  kms_key_arn = aws_kms_key.data.arn

  depends_on = [aws_cloudwatch_log_group.lambda_get_bucket]
}

resource "aws_lambda_permission" "apigw_get_bucket" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_bucket.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.skeleton.execution_arn}/*/*"
}
