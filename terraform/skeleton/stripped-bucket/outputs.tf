output "bucket_arn" {
  description = "ARN of the provisioned skeleton bucket."
  value       = aws_s3_bucket.bucket.arn
}

output "bucket_name" {
  description = "Name of the provisioned skeleton bucket."
  value       = aws_s3_bucket.bucket.id
}

output "kms_key_arn" {
  description = "ARN of the KMS key used for bucket encryption."
  value       = aws_kms_key.bucket.arn
}
