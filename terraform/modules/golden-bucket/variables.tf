# ---------------------------------------------------------------------------
# golden-bucket module — input variables
# ---------------------------------------------------------------------------

variable "bucket_name" {
  description = "Globally-unique name for the S3 bucket. Must follow S3 naming rules (3–63 chars, lowercase letters, numbers, hyphens, dots; no underscores)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3–63 characters, start and end with a lowercase letter or number, and contain only lowercase letters, numbers, hyphens, and dots."
  }
}

variable "team" {
  description = "Owning team name. Applied as the 'team' resource tag and embedded in the IAM role name."
  type        = string
}

variable "owner" {
  description = "Owner identifier (e.g. team email alias). Applied as the 'owner' resource tag."
  type        = string
}

variable "cost_center" {
  description = "Cost-center code. Applied as the 'cost-center' resource tag."
  type        = string
}

variable "path" {
  description = "Provisioning path — 'golden' (auto-provisioned paved road) or 'escape' (human-approved override). Applied as the 'path' resource tag."
  type        = string
  default     = "golden"

  validation {
    condition     = contains(["golden", "escape"], var.path)
    error_message = "path must be 'golden' or 'escape'."
  }
}

variable "kms_key_arn" {
  description = "ARN of an existing customer-managed KMS key to use for SSE-KMS. Leave empty (default) to have the module create and manage a new CMK."
  type        = string
  default     = ""

  validation {
    condition     = var.kms_key_arn == "" || can(regex("^arn:aws(-[a-z]+)*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", var.kms_key_arn))
    error_message = "kms_key_arn must be empty or a valid KMS key ARN (arn:aws:kms:<region>:<account>:key/<uuid>)."
  }
}

variable "team_role_permissions_boundary_arn" {
  description = <<-EOT
    Optional IAM permissions-boundary ARN to attach to the team role. When set,
    the team role's effective permissions are capped to the intersection of its
    attached policy and this boundary. The platform provisioner passes its
    team-role boundary here so a compromised provisioning session cannot mint an
    over-privileged role (#18 P0-2). Empty (default) => no boundary, preserving
    standalone use of this module.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.team_role_permissions_boundary_arn == "" || can(regex("^arn:aws(-[a-z]+)*:iam::[0-9]{12}:policy/.+$", var.team_role_permissions_boundary_arn))
    error_message = "team_role_permissions_boundary_arn must be empty or a valid IAM policy ARN."
  }
}

variable "trusted_principals" {
  description = "List of IAM principal ARNs (roles or users) authorised to assume the team bucket-access IAM role. Must contain at least one entry."
  type        = list(string)

  validation {
    condition     = length(var.trusted_principals) > 0
    error_message = "trusted_principals must contain at least one IAM principal ARN."
  }

  validation {
    condition     = alltrue([for arn in var.trusted_principals : can(regex("^arn:aws(-[a-z]+)*:iam::[0-9]{12}:(role|user)/.+$", arn))])
    error_message = "Each entry in trusted_principals must be a valid IAM role or user ARN."
  }
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which noncurrent object versions are permanently deleted. Applies only when versioning is enabled."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_expiration_days >= 1
    error_message = "noncurrent_version_expiration_days must be at least 1."
  }
}

variable "abort_incomplete_multipart_upload_days" {
  description = "Days after which incomplete multipart uploads are aborted."
  type        = number
  default     = 7

  validation {
    condition     = var.abort_incomplete_multipart_upload_days >= 1
    error_message = "abort_incomplete_multipart_upload_days must be at least 1."
  }
}

variable "log_retention_days" {
  description = "Days after which server access log objects are deleted from the log bucket."
  type        = number
  default     = 365

  validation {
    condition     = var.log_retention_days >= 1
    error_message = "log_retention_days must be at least 1."
  }
}

variable "kms_deletion_window_days" {
  description = "Pending-deletion window (in days) for a module-managed KMS key. Has no effect when kms_key_arn is provided."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}
