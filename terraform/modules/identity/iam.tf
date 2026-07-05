# ---------------------------------------------------------------------------
# IAM — Team roles with OIDC-conditioned trust policies.
#
# One IAM role per entry in var.team_groups. Each role:
#   • Can be assumed via sts:AssumeRoleWithWebIdentity by a holder of a valid
#     JWT whose 'groups' claim contains the configured IdP group name.
#   • Carries no inline permissions here — bucket policies (golden-bucket
#     module) and other downstream modules attach scoped permissions to these
#     role ARNs.
#
# Trust policy conditions (least-privilege):
#   aud  — must match var.oidc_audience (prevents cross-tenant token reuse).
#   groups — ForAnyValue:StringEquals on the JWT groups claim; matches only
#            tokens where the user is a member of the configured group.
#
# IdP swap: update var.oidc_provider_arn, var.oidc_issuer (changes the
# condition key prefix), and the group name values in var.team_groups. The
# IAM role names (and any bucket policies that reference them) are stable
# across IdP migrations because they derive from team names, not group names.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "team" {
  for_each = var.team_groups

  name                 = "${var.name_prefix}-team-${each.key}"
  description          = "Identity role for the '${each.key}' team (IdP group: ${each.value}). Assumed via OIDC WebIdentity by team members; bucket policies reference this ARN for scoped access."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "OIDCGroupTrust"
        Effect = "Allow"
        Principal = {
          # Federated principal — only the registered OIDC provider can issue
          # the WebIdentity assertion; no wildcard principal.
          Federated = var.oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          # aud must match the platform's registered audience — prevents
          # tokens issued for other applications from being used here.
          StringEquals = {
            "${local.oidc_issuer_host}:aud" = var.oidc_audience
          }
          # groups claim must contain exactly this team's IdP group.
          # ForAnyValue:StringEquals is the correct operator for array-valued
          # OIDC claims: it asserts that at least one element in the claim
          # array equals the specified value (no wildcards).
          "ForAnyValue:StringEquals" = {
            "${local.oidc_issuer_host}:groups" = each.value
          }
        }
      }
    ]
  })

  tags = merge(local.tags, {
    Team     = each.key
    IdPGroup = each.value
  })
}
