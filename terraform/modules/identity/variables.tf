# ---------------------------------------------------------------------------
# Identity module inputs.
#
# DESIGN PRINCIPLE — no IdP hardcoding:
#   All IdP-specific values (issuer, audience, JWKS URI) arrive as variables
#   and are stored in SSM. Swapping Okta for any OIDC-compliant IdP means
#   changing these inputs + updating the entitlements table data. Zero code
#   changes required.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  description = "Short prefix applied to every resource name (e.g. 'bucket-broker'). Keeps resources identifiable and avoids collisions across environments."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3–30 lowercase alphanumeric characters with hyphens (no leading/trailing hyphen)."
  }
}

# ---------------------------------------------------------------------------
# OIDC / IdP config — stored in SSM at apply time, read by the JWT authorizer
# at runtime. These are config, not secrets, but storing them in SSM keeps
# IdP details out of code and enables zero-code IdP swaps.
# ---------------------------------------------------------------------------

variable "oidc_issuer" {
  description = "OIDC issuer URL (e.g. 'https://dev-12345.okta.com'). Written to SSM as a String parameter. The JWT authorizer reads this at runtime to validate token issuers."
  type        = string

  validation {
    condition     = can(regex("^https://", var.oidc_issuer))
    error_message = "oidc_issuer must begin with https://."
  }
}

variable "oidc_audience" {
  description = "OIDC audience claim the platform registers with the IdP (e.g. 'api://bucket-broker'). Written to SSM as a String parameter."
  type        = string
}

variable "oidc_jwks_uri" {
  description = "JWKS URI served by the IdP (e.g. 'https://dev-12345.okta.com/oauth2/v1/keys'). Written to SSM as a SecureString parameter (KMS-encrypted at rest). The JWT authorizer caches keys from this endpoint per ADR-0004."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^https://", var.oidc_jwks_uri))
    error_message = "oidc_jwks_uri must begin with https://."
  }
}

variable "broker_principal_arns" {
  description = "IAM principal ARNs (the platform backend: request-handler / provisioner execution roles) permitted to assume the team roles, after an entitlements check. Team→group authorization is enforced upstream (authorizer + entitlements table + bucket policy), not in the trust condition — see ADR-0006. No OIDC federation."
  type        = list(string)

  validation {
    condition     = length(var.broker_principal_arns) > 0
    error_message = "broker_principal_arns must contain at least one backend principal ARN."
  }

  validation {
    condition     = alltrue([for arn in var.broker_principal_arns : can(regex("^arn:aws(-[a-z]+)*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))])
    error_message = "Each broker_principal_arns entry must be a valid IAM role ARN (no users, no wildcards)."
  }
}

# ---------------------------------------------------------------------------
# SSM path config
# ---------------------------------------------------------------------------

variable "ssm_path_prefix" {
  description = "SSM parameter store path prefix for OIDC config parameters. Defaults to '/{name_prefix}/oidc'. Change this to integrate with an existing parameter hierarchy."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# DynamoDB entitlements table
# ---------------------------------------------------------------------------

variable "entitlements_table_name" {
  description = "Override the DynamoDB entitlements table name. Defaults to '{name_prefix}-entitlements'. The table maps IdP group → {can_create, teams[], access{read,write,delete}}."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Team IAM roles — group → role mapping
#
# Keys are short team identifiers used in resource names (e.g. "platform").
# Values are the IdP group names that should be able to assume that team's
# IAM role (e.g. "platform-eng"). Adding/removing entries here provisions or
# destroys the corresponding IAM role — no code changes needed.
#
# Swapping IdPs: update oidc_issuer, oidc_audience, oidc_jwks_uri, and the
# group name values in this map. The IAM role names (and bucket policies
# referencing them) are stable across IdP swaps. Team roles are brokered by the
# backend (var.broker_principal_arns), not federated to the IdP — see ADR-0006.
# ---------------------------------------------------------------------------

variable "team_groups" {
  description = "Map of team_name → IdP_group_name. One IAM role per entry is created with an OIDC trust policy conditioned on that group. Leave empty ({}) to provision no team roles at this time; add entries to grow the fleet."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.team_groups) : can(regex("^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$|^[a-z0-9]{1,2}$", k))])
    error_message = "team_groups keys must be lowercase alphanumeric with internal hyphens only."
  }
}

# ---------------------------------------------------------------------------
# KMS
# ---------------------------------------------------------------------------

variable "kms_deletion_window_days" {
  description = "Number of days before a scheduled KMS key deletion takes effect (7–30). Provides a recovery window if a key is accidentally deleted."
  type        = number
  default     = 7

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

# ---------------------------------------------------------------------------
# Tagging
# ---------------------------------------------------------------------------

variable "tags" {
  description = "Additional resource tags merged onto every resource. Keys in this map override the module's default tags (Project, Module, ManagedBy)."
  type        = map(string)
  default     = {}
}
