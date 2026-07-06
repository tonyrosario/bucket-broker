# ---------------------------------------------------------------------------
# Outputs — consumed by platform-api, golden-bucket, and env composition.
# ---------------------------------------------------------------------------

# DynamoDB entitlements table

output "entitlements_table_name" {
  description = "Name of the DynamoDB entitlements table. The request-handler Lambda uses this to look up group → access rights at runtime."
  value       = aws_dynamodb_table.entitlements.name
}

output "entitlements_table_arn" {
  description = "ARN of the DynamoDB entitlements table. Use this to grant DynamoDB read access to the request-handler Lambda execution role."
  value       = aws_dynamodb_table.entitlements.arn
}

# KMS identity key

output "kms_key_arn" {
  description = "ARN of the identity module's CMK. Grant kms:Decrypt on this key to any principal that reads SSM SecureString params or DynamoDB items from this module."
  value       = aws_kms_key.identity.arn
}

output "kms_key_id" {
  description = "Key ID (UUID) of the identity CMK. Useful for constructing alias ARNs or cross-module references."
  value       = aws_kms_key.identity.key_id
}

output "kms_alias_arn" {
  description = "ARN of the KMS alias for the identity CMK."
  value       = aws_kms_alias.identity.arn
}

# SSM parameter names (not values — values are encrypted; callers read at runtime)

output "ssm_oidc_issuer_name" {
  description = "SSM parameter name for the OIDC issuer URL. Pass to the JWT authorizer Lambda as an env var so it can fetch the value at cold-start."
  value       = aws_ssm_parameter.oidc_issuer.name
}

output "ssm_oidc_audience_name" {
  description = "SSM parameter name for the OIDC audience. Pass to the JWT authorizer Lambda as an env var."
  value       = aws_ssm_parameter.oidc_audience.name
}

output "ssm_oidc_jwks_uri_name" {
  description = "SSM parameter name for the OIDC JWKS URI (SecureString). Pass to the JWT authorizer Lambda as an env var; the Lambda needs kms:Decrypt on the identity CMK to read it."
  value       = aws_ssm_parameter.oidc_jwks_uri.name
}

# SSM parameter ARNs (for IAM policy scoping)

output "ssm_oidc_issuer_arn" {
  description = "ARN of the OIDC issuer SSM parameter. Use in IAM policy Resource fields to grant read access with least privilege."
  value       = aws_ssm_parameter.oidc_issuer.arn
}

output "ssm_oidc_audience_arn" {
  description = "ARN of the OIDC audience SSM parameter."
  value       = aws_ssm_parameter.oidc_audience.arn
}

output "ssm_oidc_jwks_uri_arn" {
  description = "ARN of the OIDC JWKS URI SSM parameter (SecureString). Callers must also have kms:Decrypt on kms_key_arn to read this value."
  value       = aws_ssm_parameter.oidc_jwks_uri.arn
}

# Team IAM role ARNs — map of team_name → role_arn
# Bucket policies and golden-bucket module use these ARNs to grant scoped
# S3 access. The map is stable across IdP swaps (roles are named after teams,
# not after IdP groups).

output "team_role_arns" {
  description = "Map of team_name → IAM role ARN for each entry in var.team_groups. Bucket policies reference these ARNs to grant team-scoped S3 access."
  value       = { for k, r in aws_iam_role.team : k => r.arn }
}

output "team_role_names" {
  description = "Map of team_name → IAM role name for each entry in var.team_groups."
  value       = { for k, r in aws_iam_role.team : k => r.name }
}
