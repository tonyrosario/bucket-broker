# ---------------------------------------------------------------------------
# Example: complete identity module deployment (dev / demo).
#
# Demonstrates:
#   • Calling the identity module with config-driven OIDC inputs.
#   • A sample entitlements fixture item for the "platform-eng" demo team.
#   • Swapping the IdP: change the module inputs (oidc_issuer, oidc_audience,
#     oidc_jwks_uri, oidc_provider_arn) and update group values in team_groups.
#     No Terraform code changes required — only variable/data changes.
#
# NOT for production: the OIDC values below are illustrative placeholders.
# Replace all values marked "EXAMPLE" before applying to a real environment.
# ---------------------------------------------------------------------------

module "identity" {
  source = "../../"

  name_prefix = "bucket-broker"

  # IdP config — swap the IdP by changing these four values + team_groups.
  # Values are written to SSM; the JWT authorizer reads them at runtime.
  oidc_issuer       = "https://dev-12345.example-idp.com"         # EXAMPLE — replace with real issuer URL
  oidc_audience     = "api://bucket-broker"                       # EXAMPLE — replace with real audience
  oidc_jwks_uri     = "https://dev-12345.example-idp.com/v1/keys" # EXAMPLE — replace with real JWKS URI
  oidc_provider_arn = var.oidc_provider_arn

  # One team for demo purposes. Add more entries as teams onboard.
  # key   = short team identifier (used in IAM role name and output map keys)
  # value = IdP group name that maps to this team (must match the JWT groups claim)
  team_groups = {
    "platform" = "platform-eng" # EXAMPLE demo team
  }

  tags = {
    Environment = "dev"
    Example     = "true"
  }
}

# ---------------------------------------------------------------------------
# EXAMPLE seed item — one entitlements record for the demo "platform-eng" team.
#
# IMPORTANT: This resource is for demonstration and local testing only.
#   • In production, populate the entitlements table via a controlled data
#     pipeline, IaC data module, or a migration script — not inline Terraform.
#   • Removing this resource from production Terraform will delete the item;
#     use lifecycle { prevent_destroy = true } or an external seeding mechanism.
#
# Item schema (see modules/identity/README.md for full documentation):
#   group      (S)    — IdP group name (PK), must match the JWT groups claim.
#   can_create (BOOL) — may members provision new buckets?
#   teams      (L)    — list of team identifiers this group administers.
#   access     (M)    — per-operation flags: read / write / delete.
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table_item" "fixture_platform_eng" {
  table_name = module.identity.entitlements_table_name
  hash_key   = "group"

  # DynamoDB AttributeValue JSON format.
  item = jsonencode({
    group      = { S = "platform-eng" }
    can_create = { BOOL = true }
    teams = {
      L = [
        { S = "platform" },
        { S = "infra" }
      ]
    }
    access = {
      M = {
        read   = { BOOL = true }
        write  = { BOOL = true }
        delete = { BOOL = true }
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Outputs — surface module outputs for integration testing / env composition.
# ---------------------------------------------------------------------------

output "entitlements_table_name" {
  description = "Entitlements DynamoDB table name."
  value       = module.identity.entitlements_table_name
}

output "team_role_arns" {
  description = "Map of team_name → IAM role ARN."
  value       = module.identity.team_role_arns
}

output "ssm_oidc_issuer_name" {
  description = "SSM parameter name for the OIDC issuer."
  value       = module.identity.ssm_oidc_issuer_name
}

output "ssm_oidc_jwks_uri_name" {
  description = "SSM parameter name for the OIDC JWKS URI (SecureString)."
  value       = module.identity.ssm_oidc_jwks_uri_name
}

output "kms_key_arn" {
  description = "Identity CMK ARN."
  value       = module.identity.kms_key_arn
}
