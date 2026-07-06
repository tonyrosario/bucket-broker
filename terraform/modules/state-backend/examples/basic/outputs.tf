output "state_bucket_name" {
  description = "S3 bucket name — use as `bucket` in backend config."
  value       = module.state_backend.state_bucket_name
}

output "lock_table_name" {
  description = "DynamoDB table name — use as `dynamodb_table` in backend config."
  value       = module.state_backend.lock_table_name
}

output "kms_key_arn" {
  description = "KMS key ARN — use as `kms_key_id` in backend config."
  value       = module.state_backend.kms_key_arn
}

output "state_bucket_arn" {
  description = "S3 bucket ARN — use in IAM policies for the Terraform runner role."
  value       = module.state_backend.state_bucket_arn
}

output "lock_table_arn" {
  description = "DynamoDB table ARN — use in IAM policies for the Terraform runner role."
  value       = module.state_backend.lock_table_arn
}
