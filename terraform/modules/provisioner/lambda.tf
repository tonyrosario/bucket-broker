# ---------------------------------------------------------------------------
# Glue Lambda — validate the request, render JSON tfvars, and write the
# idempotent PENDING -> PROVISIONING transition. Source lives in
# src/provisioner-glue (Node.js 20 / TypeScript, ADR-0005).
#
# For plan/validate (and CI, which has no build step) the function packages a
# committed placeholder handler. A live deploy sets var.lambda_source_dir to the
# compiled dist/ of src/provisioner-glue.
# ---------------------------------------------------------------------------

data "archive_file" "glue" {
  type        = "zip"
  output_path = "${path.module}/dist/glue.zip"
  source_dir  = var.lambda_source_dir != "" ? var.lambda_source_dir : "${path.module}/lambda/placeholder"
}

resource "aws_lambda_function" "glue" { # tfsec:ignore:aws-lambda-enable-tracing
  #checkov:skip=CKV_AWS_50:X-Ray tracing wiring is owned by the observability module (#23); the logging lib no-ops when X-Ray is absent.
  #checkov:skip=CKV_AWS_117:No VPC for the glue Lambda; it calls only DynamoDB (AWS API), no private-subnet resources.
  #checkov:skip=CKV_AWS_116:The async failure path + DLQ live on the Step Functions execution, not the synchronous Lambda invocation.
  #checkov:skip=CKV_AWS_115:Reserved concurrency is not set at demo volume; concurrency is bounded upstream by the CodeBuild concurrent_build_limit.
  #checkov:skip=CKV_AWS_272:Code-signing deferred to the hardening milestone (#24).
  function_name    = "${local.prefix}-render-tfvars"
  description      = "Provisioner glue: validate request, render JSON tfvars, set PROVISIONING (idempotent)."
  role             = aws_iam_role.glue.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.glue.output_path
  source_code_hash = data.archive_file.glue.output_base64sha256
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_mb

  environment {
    variables = {
      STATUS_TABLE              = aws_dynamodb_table.status.name
      STATE_KEY_PREFIX          = local.state_key_prefix
      PROVISIONED_BUCKET_PREFIX = var.provisioned_bucket_prefix
      # Mandatory permissions boundary the runner root attaches to every team
      # role; the provisioning role's iam:CreateRole grant requires this exact
      # ARN (#18 P0-2). The glue fails closed if it is unset.
      TEAM_ROLE_PERMISSIONS_BOUNDARY_ARN = aws_iam_policy.team_role_boundary.arn
      # Concrete broker principal ARNs rendered into golden-bucket's
      # trusted_principals (ADR-0006, no OIDC federation).
      BROKER_PRINCIPAL_ARNS = jsonencode(var.broker_principal_arns)
    }
  }

  kms_key_arn = aws_kms_key.data.arn

  depends_on = [aws_cloudwatch_log_group.glue]
}
