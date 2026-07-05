variable "prefix" {
  description = "Naming prefix applied to every resource this module creates. Must be globally unique enough that the resulting S3 bucket name (<prefix>-tfstate) does not collide with an existing bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.prefix))
    error_message = "prefix must be 3–32 characters, start and end with a lowercase letter or digit, and contain only lowercase letters, digits, and hyphens."
  }
}

variable "tags" {
  description = "Map of tags to apply to all resources created by this module."
  type        = map(string)
  default     = {}
}

variable "noncurrent_version_retention_days" {
  description = "Number of days to retain noncurrent (previous) Terraform state object versions before expiration. Keeping history is useful for state rollbacks."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 7 && var.noncurrent_version_retention_days <= 3650
    error_message = "noncurrent_version_retention_days must be between 7 and 3650."
  }
}

variable "kms_deletion_window_days" {
  description = "Waiting period (in days) before AWS permanently deletes the KMS key after it has been scheduled for deletion. Allowed values: 7–30."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 (minimum AWS allows) and 30."
  }
}

variable "terraform_state_principals" {
  description = <<-EOT
    Optional list of IAM principal ARNs (roles or users) that need explicit KMS
    encrypt/decrypt access to manage Terraform state — typically the IAM role
    assumed by the Terraform runner (e.g. CodeBuild). Leave empty if the calling
    principals already have kms:GenerateDataKey / kms:Decrypt granted via their
    IAM policies (safe because the root-account statement in the key policy allows
    IAM policies to control access).
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.terraform_state_principals : can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/", p))])
    error_message = "Each entry in terraform_state_principals must be a valid IAM role or user ARN (arn:aws:iam::<account>:role/<name> or arn:aws:iam::<account>:user/<name>)."
  }
}
