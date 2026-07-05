output "api_endpoint" {
  description = "Base URL for the skeleton API."
  value       = "https://${aws_api_gateway_rest_api.skeleton.id}.execute-api.${local.region}.amazonaws.com/${aws_api_gateway_stage.skeleton.stage_name}"
}

output "post_buckets_url" {
  description = "POST endpoint for submitting a bucket provision request."
  value       = "https://${aws_api_gateway_rest_api.skeleton.id}.execute-api.${local.region}.amazonaws.com/${aws_api_gateway_stage.skeleton.stage_name}/buckets"
}

output "requests_table_name" {
  description = "DynamoDB table name for provision requests."
  value       = aws_dynamodb_table.requests.name
}

output "state_machine_arn" {
  description = "Step Functions state machine ARN for the skeleton provisioner."
  value       = aws_sfn_state_machine.provisioner.arn
}

output "codebuild_project_name" {
  description = "CodeBuild project name for the Terraform runner."
  value       = aws_codebuild_project.terraform_runner.name
}

output "dlq_url" {
  description = "SQS DLQ URL for failed provisioning executions."
  value       = aws_sqs_queue.dlq.url
}
