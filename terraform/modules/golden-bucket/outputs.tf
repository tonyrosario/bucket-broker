# ---------------------------------------------------------------------------
# golden-bucket module — outputs
# ---------------------------------------------------------------------------

output "bucket_arn" {
  description = "ARN of the provisioned golden bucket."
  value       = aws_s3_bucket.bucket.arn
}

output "bucket_id" {
  description = "ID (name) of the provisioned golden bucket."
  value       = aws_s3_bucket.bucket.id
}

output "bucket_domain_name" {
  description = "Regional domain name of the provisioned golden bucket."
  value       = aws_s3_bucket.bucket.bucket_regional_domain_name
}

output "kms_key_arn" {
  description = "ARN of the KMS key used for SSE-KMS (module-managed or caller-supplied)."
  value       = local.kms_key_arn
}

output "kms_key_id" {
  description = "Key ID of the module-managed KMS key; empty string if a caller-supplied key is used."
  value       = local.create_kms_key ? aws_kms_key.bucket[0].key_id : ""
}

output "log_bucket_arn" {
  description = "ARN of the server access log bucket."
  value       = aws_s3_bucket.access_logs.arn
}

output "log_bucket_id" {
  description = "ID (name) of the server access log bucket."
  value       = aws_s3_bucket.access_logs.id
}

output "team_role_arn" {
  description = "ARN of the team IAM role that holds scoped CRUD access to the golden bucket."
  value       = aws_iam_role.team.arn
}

output "team_role_name" {
  description = "Name of the team IAM role."
  value       = aws_iam_role.team.name
}
