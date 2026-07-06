# ---------------------------------------------------------------------------
# Outputs — the seam #19 attaches to.
#
# #19 creates the API Gateway REST API + WAF + request-handler and wires this
# authorizer in as a REQUEST authorizer via `authorizer_lambda_invoke_arn`
# (aws_api_gateway_authorizer.authorizer_uri) and grants API Gateway permission
# to invoke it using `authorizer_lambda_function_name` / `_arn`.
# ---------------------------------------------------------------------------

output "authorizer_lambda_function_name" {
  description = "Name of the JWT authorizer Lambda. Use when granting API Gateway invoke permission (aws_lambda_permission.function_name)."
  value       = aws_lambda_function.authorizer.function_name
}

output "authorizer_lambda_function_arn" {
  description = "ARN of the JWT authorizer Lambda function."
  value       = aws_lambda_function.authorizer.arn
}

output "authorizer_lambda_invoke_arn" {
  description = "Invoke ARN of the JWT authorizer Lambda. This is the value API Gateway needs for aws_api_gateway_authorizer.authorizer_uri (#19)."
  value       = aws_lambda_function.authorizer.invoke_arn
}

output "authorizer_role_arn" {
  description = "ARN of the authorizer Lambda's execution role. Exposed for auditing / cross-module reference; it is already least-privilege."
  value       = aws_iam_role.authorizer.arn
}

output "authorizer_role_name" {
  description = "Name of the authorizer Lambda's execution role."
  value       = aws_iam_role.authorizer.name
}

output "authorizer_log_group_name" {
  description = "Name of the authorizer's CloudWatch log group (CMK-encrypted). Observability (#22) can attach metric filters / alarms (e.g. auth-failure rate) here."
  value       = aws_cloudwatch_log_group.authorizer.name
}

output "authorizer_log_kms_key_arn" {
  description = "ARN of the CMK encrypting the authorizer log group."
  value       = aws_kms_key.logs.arn
}
