# ---------------------------------------------------------------------------
# platform-api (authorizer slice) — data sources and locals.
#
# Responsibilities (issue #17):
#   • The JWT authorizer Lambda (validates JWT vs cached JWKS, fail-closed).
#   • Its least-privilege execution role (SSM GetParameters on the OIDC params
#     only; KMS Decrypt on the identity CMK only; scoped CloudWatch Logs).
#   • A KMS-encrypted log group and its encryption key.
#   • Outputs (Lambda ARN + invoke ARN) for #19 to attach as the API Gateway
#     REQUEST authorizer.
#
# NOT here (owned by #19): API Gateway, WAF, request-handler Lambda, request
# table. See README.md.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition

  function_name = "${var.name_prefix}-jwt-authorizer"
  log_group_arn = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.function_name}"

  # The three SSM parameter NAMES the authorizer reads at cold start. These are
  # always set by the module; callers cannot override them.
  managed_environment = {
    SSM_OIDC_ISSUER_NAME   = var.ssm_oidc_issuer_name
    SSM_OIDC_AUDIENCE_NAME = var.ssm_oidc_audience_name
    SSM_OIDC_JWKS_URI_NAME = var.ssm_oidc_jwks_uri_name
  }

  environment = merge(var.additional_environment_variables, local.managed_environment)

  tags = merge(
    {
      Project   = "bucket-broker"
      Module    = "platform-api"
      Component = "jwt-authorizer"
      ManagedBy = "terraform"
    },
    var.tags
  )
}
