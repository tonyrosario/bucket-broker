output "state_bucket_name" {
  description = "Name of the S3 bucket that stores Terraform state. Use as the `bucket` value in a backend \"s3\" block."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the S3 state bucket. Use in IAM policies to grant read/write access to the Terraform runner role."
  value       = aws_s3_bucket.state.arn
}

output "lock_table_name" {
  description = "Name of the DynamoDB lock table. Use as the `dynamodb_table` value in a backend \"s3\" block."
  value       = aws_dynamodb_table.lock.name
}

output "lock_table_arn" {
  description = "ARN of the DynamoDB lock table. Use in IAM policies to grant dynamodb:GetItem/PutItem/DeleteItem to the Terraform runner role."
  value       = aws_dynamodb_table.lock.arn
}

output "kms_key_arn" {
  description = "ARN of the KMS CMK that encrypts the state bucket and lock table. Use as the `kms_key_id` value in a backend \"s3\" block."
  value       = aws_kms_key.state.arn
}

output "kms_key_id" {
  description = "Key ID of the KMS CMK (the UUID portion of the ARN). Provided for convenience where the short ID is required."
  value       = aws_kms_key.state.key_id
}

output "kms_alias_name" {
  description = "Alias name of the KMS CMK (e.g. alias/acme-dev-tfstate). Human-readable reference for the AWS console."
  value       = aws_kms_alias.state.name
}
