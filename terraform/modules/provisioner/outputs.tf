# ---------------------------------------------------------------------------
# provisioner module — outputs
# ---------------------------------------------------------------------------

output "state_machine_arn" {
  description = "ARN of the provisioner Step Functions state machine. The request-handler (#19) starts executions here with name=requestId."
  value       = aws_sfn_state_machine.provisioner.arn
}

output "state_machine_name" {
  description = "Name of the provisioner Step Functions state machine."
  value       = aws_sfn_state_machine.provisioner.name
}

output "status_table_name" {
  description = "Name of the DynamoDB status table (PENDING/PROVISIONING/READY/FAILED). The request-handler writes the initial PENDING record here."
  value       = aws_dynamodb_table.status.name
}

output "status_table_arn" {
  description = "ARN of the DynamoDB status table."
  value       = aws_dynamodb_table.status.arn
}

output "codebuild_project_name" {
  description = "Name of the CodeBuild Terraform-runner project."
  value       = aws_codebuild_project.terraform_runner.name
}

output "codebuild_project_arn" {
  description = "ARN of the CodeBuild Terraform-runner project."
  value       = aws_codebuild_project.terraform_runner.arn
}

output "runner_role_arn" {
  description = "ARN of the minimal CodeBuild runner service role (logs + assume-provisioning only)."
  value       = aws_iam_role.codebuild.arn
}

output "provisioning_role_arn" {
  description = "ARN of the ABAC provisioning role that terraform actually runs as (assumed per request with BucketName/Team/RequestId session tags)."
  value       = aws_iam_role.provisioning.arn
}

output "glue_function_name" {
  description = "Name of the glue (render/validate) Lambda function."
  value       = aws_lambda_function.glue.function_name
}

output "glue_function_arn" {
  description = "ARN of the glue Lambda function."
  value       = aws_lambda_function.glue.arn
}

output "dlq_url" {
  description = "URL of the SQS dead-letter queue for failed provisioning executions."
  value       = aws_sqs_queue.dlq.url
}

output "dlq_arn" {
  description = "ARN of the SQS dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "data_kms_key_arn" {
  description = "ARN of the module data KMS key (status table, DLQ, Lambda env)."
  value       = aws_kms_key.data.arn
}

output "audit_bucket_name" {
  description = "Name of the interim state-audit CloudTrail bucket, or null when disabled."
  value       = var.enable_state_bucket_audit_trail ? aws_s3_bucket.audit[0].id : null
}
