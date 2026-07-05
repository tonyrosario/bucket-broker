# ---------------------------------------------------------------------------
# SSM Parameter Store — OIDC / IdP configuration.
#
# The JWT authorizer reads issuer, audience, and JWKS URI from SSM at runtime
# so IdP config never touches application code. Swapping the IdP means
# updating these parameters (and the entitlements table) — no redeployment.
#
# Tier choice: Standard (free up to 10,000 params). Promote to Advanced only
# if parameter size or throughput requires it.
#
# Encryption: all three parameters are SecureString encrypted with the
# identity CMK. Although the issuer and audience are technically public OIDC
# metadata, encrypting them at rest provides defence-in-depth and simplifies
# the IAM model: the JWT authorizer needs kms:Decrypt on the identity key for
# the JWKS URI anyway, so adding the other two params has no extra cost.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "oidc_issuer" {
  name        = "${local.ssm_prefix}/issuer"
  description = "OIDC issuer URL used by the JWT authorizer to validate token issuers. Changing this value is the first step of an IdP migration."
  type        = "SecureString"
  key_id      = aws_kms_key.identity.arn
  value       = var.oidc_issuer
  tier        = "Standard"

  tags = local.tags
}

resource "aws_ssm_parameter" "oidc_audience" {
  name        = "${local.ssm_prefix}/audience"
  description = "OIDC audience claim the platform registers with the IdP. JWT authorizer rejects tokens whose 'aud' claim does not match this value."
  type        = "SecureString"
  key_id      = aws_kms_key.identity.arn
  value       = var.oidc_audience
  tier        = "Standard"

  tags = local.tags
}

resource "aws_ssm_parameter" "oidc_jwks_uri" {
  name        = "${local.ssm_prefix}/jwks-uri"
  description = "JWKS URI served by the IdP. The JWT authorizer fetches signing keys from this endpoint and caches them (stale-while-revalidate per ADR-0004). Stored as SecureString encrypted with the identity CMK."
  type        = "SecureString"
  key_id      = aws_kms_key.identity.arn
  value       = var.oidc_jwks_uri
  tier        = "Standard"

  tags = local.tags
}
