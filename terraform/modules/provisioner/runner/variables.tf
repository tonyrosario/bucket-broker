# ---------------------------------------------------------------------------
# Runner root — variables. Values arrive as terraform.auto.tfvars.json, rendered
# by the glue Lambda with JSON.stringify (never string-concatenated into HCL).
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for the provider."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Golden bucket name (validated by the glue and by the golden-bucket module)."
  type        = string
}

variable "team" {
  description = "Owning team."
  type        = string
}

variable "owner" {
  description = "Owner identifier (e.g. team email alias)."
  type        = string
}

variable "cost_center" {
  description = "Cost-center code."
  type        = string
}

variable "path" {
  description = "Provisioning path (golden|escape)."
  type        = string
  default     = "golden"
}

variable "trusted_principals" {
  description = "Concrete platform broker principal ARNs the team role trusts (ADR-0006; no OIDC federation)."
  type        = list(string)
}
