# ---------------------------------------------------------------------------
# identity module — data sources and locals
#
# Responsibilities:
#   1. OIDC config (issuer, audience, JWKS URI) in SSM Parameter Store so
#      the JWT authorizer can read them at runtime — IdP is swappable with
#      zero code changes (see authorization model in docs/design/architecture.md).
#   2. entitlements DynamoDB table mapping IdP group → access rights (data,
#      not code — swap IdP by changing config + table, never code).
#   3. Team IAM roles whose trust policies are conditioned on the IdP group
#      claim — bucket policies reference these role ARNs.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  # OIDC issuer without the https:// prefix — used in IAM condition keys.
  # AWS IAM OIDC condition key format: <issuer-host-and-path>:<claim>
  # e.g. "dev-12345.okta.com:groups" not "https://dev-12345.okta.com:groups"
  oidc_issuer_host = trimprefix(var.oidc_issuer, "https://")

  # SSM path prefix — default to /{name_prefix}/oidc unless overridden.
  ssm_prefix = var.ssm_path_prefix != "" ? var.ssm_path_prefix : "/${var.name_prefix}/oidc"

  # Entitlements table name — default to {name_prefix}-entitlements.
  entitlements_table_name = var.entitlements_table_name != "" ? var.entitlements_table_name : "${var.name_prefix}-entitlements"

  # Merged tags applied to every resource.
  tags = merge(
    {
      Project   = "bucket-broker"
      Module    = "identity"
      ManagedBy = "terraform"
    },
    var.tags
  )
}
