output "bucket_arn" {
  description = "ARN of the provisioned golden bucket."
  value       = module.golden_bucket.bucket_arn
}

output "bucket_id" {
  description = "Name of the provisioned golden bucket."
  value       = module.golden_bucket.bucket_id
}

output "team_role_arn" {
  description = "ARN of the team CRUD IAM role for the provisioned bucket."
  value       = module.golden_bucket.team_role_arn
}

output "kms_key_arn" {
  description = "ARN of the KMS key protecting the provisioned bucket."
  value       = module.golden_bucket.kms_key_arn
}
