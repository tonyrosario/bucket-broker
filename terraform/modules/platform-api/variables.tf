# ---------------------------------------------------------------------------
# platform-api (authorizer slice) — inputs.
#
# SCOPE (issue #17): this file set provisions ONLY the JWT authorizer Lambda
# and its least-privilege IAM. The API Gateway, WAF, request-handler Lambda,
# and request table are #19's and are intentionally NOT declared here. See
# README.md for the module boundary #19 extends.
#
# The OIDC SSM parameter ARNs/names and the identity CMK ARN come from the
# identity module's outputs (#12) — nothing about the IdP is hardcoded.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  description = "Short prefix applied to every resource name (e.g. 'bucket-broker')."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3–30 lowercase alphanumeric characters with hyphens (no leading/trailing hyphen)."
  }
}

# --- OIDC config wiring (from identity module outputs) ---------------------

variable "ssm_oidc_issuer_name" {
  description = "SSM parameter NAME for the OIDC issuer. Passed to the authorizer Lambda as an env var; read at cold start."
  type        = string
}

variable "ssm_oidc_audience_name" {
  description = "SSM parameter NAME for the OIDC audience."
  type        = string
}

variable "ssm_oidc_jwks_uri_name" {
  description = "SSM parameter NAME for the OIDC JWKS URI (SecureString)."
  type        = string
}

variable "ssm_oidc_parameter_arns" {
  description = "ARNs of the three OIDC SSM parameters (issuer, audience, jwks-uri). Used to scope the authorizer's ssm:GetParameters permission to exactly these parameters — least privilege, no wildcard."
  type        = list(string)

  validation {
    condition     = length(var.ssm_oidc_parameter_arns) == 3
    error_message = "ssm_oidc_parameter_arns must contain exactly the three OIDC parameter ARNs (issuer, audience, jwks-uri)."
  }
}

variable "oidc_kms_key_arn" {
  description = "ARN of the identity CMK that encrypts the SecureString OIDC parameters. The authorizer is granted kms:Decrypt on ONLY this key so it can read the JWKS URI parameter."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:kms:", var.oidc_kms_key_arn))
    error_message = "oidc_kms_key_arn must be a KMS key ARN."
  }
}

# --- Lambda packaging & runtime -------------------------------------------

variable "lambda_package_path" {
  description = "Path to the built authorizer deployment package (.zip). The build/CI pipeline compiles src/authorizer and produces this artifact; env composition supplies the real path. Defaults to a conventional location so `terraform validate` succeeds without the artifact present."
  type        = string
  default     = "dist/authorizer.zip"
}

variable "lambda_handler" {
  description = "Lambda handler entrypoint (compiled from src/authorizer/src/index.ts)."
  type        = string
  default     = "index.handler"
}

variable "lambda_runtime" {
  description = "Lambda runtime. Node.js 20 per ADR-0005."
  type        = string
  default     = "nodejs20.x"
}

variable "lambda_memory_mb" {
  description = "Lambda memory (MB). Authorizer is CPU-light; 256 MB is ample and keeps cold starts fast."
  type        = number
  default     = 256
}

variable "lambda_timeout_seconds" {
  description = "Lambda timeout (seconds). Kept short: the authorizer must respond well inside API Gateway's authorizer timeout, and JWKS calls have their own resilience timeout."
  type        = number
  default     = 10
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrency for the authorizer (ADR-0004 bulkhead isolation, so a JWKS slowdown can't exhaust account-wide concurrency shared with other functions). Set to a concrete value; -1 disables the reservation."
  type        = number
  default     = 10
}

variable "additional_environment_variables" {
  description = "Optional extra env vars merged into the authorizer's environment (e.g. JWKS cache TTL / breaker tunables, GROUPS_CLAIM, CLOCK_SKEW_SEC). The three SSM_OIDC_*_NAME vars are always set by the module and cannot be overridden here."
  type        = map(string)
  default     = {}
}

# --- Logging ---------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch Logs retention (days) for the authorizer's log group."
  type        = number
  default     = 365
}

variable "tags" {
  description = "Additional tags merged onto every resource."
  type        = map(string)
  default     = {}
}
