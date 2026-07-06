# ---------------------------------------------------------------------------
# IAM — Team roles with platform-brokered trust (ADR-0006).
#
# One IAM role per entry in var.team_groups. Each role:
#   • Is assumed by the platform BACKEND (request-handler / provisioner) via
#     var.broker_principal_arns, AFTER the backend has checked the caller's
#     entitlements (group→team) against the entitlements table. Users never
#     assume these roles directly.
#   • Carries no inline permissions here — bucket policies (golden-bucket
#     module) and other downstream modules attach scoped permissions to these
#     role ARNs.
#
# Why not user-assumed OIDC (sts:AssumeRoleWithWebIdentity gated on a `groups`
# claim)? AWS STS does not surface arbitrary/array custom claims such as
# `groups` as IAM trust condition keys for generic OIDC federation, so that
# trust is either inert or — with a single shared audience — assumable by any
# authenticated user. Team→group authorization therefore lives in the
# authorizer + entitlements table + bucket policy (the design's source of
# truth), and the backend brokers the role assumption. See ADR-0006.
#
# IdP swap: update the OIDC config in SSM (var.oidc_issuer / _audience /
# _jwks_uri) and the group values in var.team_groups. Role names derive from
# team names, so they — and any bucket policies referencing them — are stable
# across IdP migrations.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "team" {
  for_each = var.team_groups

  name                 = "${var.name_prefix}-team-${each.key}"
  description          = "Identity role for the '${each.key}' team (IdP group: ${each.value}). Assumed by the platform backend after an entitlements check; bucket policies reference this ARN for scoped access."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PlatformBrokeredTrust"
        Effect = "Allow"
        Principal = {
          # Only the platform backend principals (request-handler / provisioner
          # execution roles) may assume team roles — no federation, no wildcard.
          # WHICH team role is assumed is decided by the backend after the
          # entitlements (group→team) check; that is the authorization gate.
          AWS = var.broker_principal_arns
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = merge(local.tags, {
    Team     = each.key
    IdPGroup = each.value
  })
}
