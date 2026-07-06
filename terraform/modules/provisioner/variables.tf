# ---------------------------------------------------------------------------
# provisioner module — input variables
#
# The provisioner CONSUMES the outputs of the state-backend module (#9) as
# inputs (bucket/lock/KMS ARNs). It does NOT re-instantiate state-backend, and
# it never populates state-backend's `terraform_state_principals` grant — the
# runner obtains state-KMS access through its own identity policy, scoped with
# kms:ViaService + aws:SourceAccount (see iam.tf). This keeps the state-backend
# key-policy grant dormant (as #9 intends) while still meeting #9 iac-1.
# ---------------------------------------------------------------------------

variable "prefix" {
  description = "Naming prefix applied to every resource this module creates (state machine, CodeBuild project, status table, DLQ, IAM roles, log groups, KMS keys)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.prefix))
    error_message = "prefix must be 3-32 characters, start and end with a lowercase letter or digit, and contain only lowercase letters, digits, and hyphens."
  }
}

variable "aws_region" {
  description = "AWS region the provisioner and its CodeBuild runner operate in. Used to build kms:ViaService condition values and the runner backend config."
  type        = string
  default     = "us-east-1"
}

# --- state-backend wiring (outputs of module.state-backend) -----------------

variable "state_bucket_name" {
  description = "Name of the S3 Terraform-state bucket (state-backend output `state_bucket_name`). Passed to the CodeBuild runner as the backend `bucket`."
  type        = string
}

variable "state_bucket_arn" {
  description = "ARN of the S3 Terraform-state bucket (state-backend output `state_bucket_arn`). Used to scope the runner's state object access to the per-request key prefix only."
  type        = string

  validation {
    condition     = can(regex("^arn:aws(-[a-z]+)*:s3:::[a-z0-9.-]+$", var.state_bucket_arn))
    error_message = "state_bucket_arn must be a valid S3 bucket ARN (arn:aws:s3:::<bucket>)."
  }
}

variable "lock_table_name" {
  description = "Name of the DynamoDB state-lock table (state-backend output `lock_table_name`). Passed to the runner as the backend `dynamodb_table`."
  type        = string
}

variable "lock_table_arn" {
  description = "ARN of the DynamoDB state-lock table (state-backend output `lock_table_arn`). Used to scope the runner's lock GetItem/PutItem/DeleteItem."
  type        = string

  validation {
    condition     = can(regex("^arn:aws(-[a-z]+)*:dynamodb:[a-z0-9-]+:[0-9]{12}:table/.+$", var.lock_table_arn))
    error_message = "lock_table_arn must be a valid DynamoDB table ARN."
  }
}

variable "state_kms_key_arn" {
  description = <<-EOT
    ARN of the KMS CMK that encrypts BOTH the state bucket and the lock table
    (state-backend output `kms_key_arn`). The runner is granted use of this key
    ONLY via kms:ViaService (s3 + dynamodb) + aws:SourceAccount, so a compromised
    runner cannot Decrypt an exfiltrated state blob through the KMS API directly
    (#9 iac-1). Because state-backend encrypts the lock table with THIS key (not a
    data key), the runner never needs a separate data key (#16 P1).
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws(-[a-z]+)*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", var.state_kms_key_arn))
    error_message = "state_kms_key_arn must be a valid KMS key ARN (arn:aws:kms:<region>:<account>:key/<uuid>)."
  }
}

# --- golden-bucket wiring (ADR-0006) ----------------------------------------

variable "broker_principal_arns" {
  description = <<-EOT
    Concrete platform backend broker principal ARNs (e.g. the request-handler
    execution role) that the per-request golden-bucket TEAM role is configured to
    trust, per ADR-0006 (platform-brokered team-role assumption; NO OIDC
    federation). Rendered by the glue into golden-bucket's `trusted_principals`
    tfvar. Must be in-account IAM ARNs (cross-account rejected at apply; see the
    precondition in iam.tf) per ADR-0001 in-account design (#9 iac-3).
  EOT
  type        = list(string)

  validation {
    condition     = length(var.broker_principal_arns) > 0
    error_message = "broker_principal_arns must contain at least one IAM principal ARN."
  }

  validation {
    condition     = alltrue([for a in var.broker_principal_arns : can(regex("^arn:aws(-[a-z]+)*:iam::[0-9]{12}:(role|user)/.+$", a))])
    error_message = "Each broker_principal_arns entry must be a valid IAM role or user ARN."
  }
}

variable "provisioned_bucket_prefix" {
  description = <<-EOT
    Naming prefix that every per-request golden bucket name MUST start with. The
    provisioning role's trust policy only permits a session whose BucketName tag
    matches `<prefix>*`, bounding the ABAC blast radius so the runner can never
    target a pre-existing bucket outside the platform namespace. The effective
    per-request permission is still the EXACT bucket ARN (iam.tf uses the
    BucketName session tag as a policy variable), satisfying #16 iac-4.
  EOT
  type        = string
  default     = "bucketbroker"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,40}$", var.provisioned_bucket_prefix))
    error_message = "provisioned_bucket_prefix must be a DNS-safe S3 name fragment (lowercase letters, digits, dots, hyphens)."
  }
}

# --- CodeBuild runner -------------------------------------------------------

variable "codebuild_source_location" {
  description = "Git HTTPS URL the CodeBuild runner checks out (repo containing the golden-bucket module and the runner root config)."
  type        = string
  default     = "https://github.com/tonyrosario/bucket-broker.git"
}

variable "codebuild_source_version" {
  description = "Immutable git commit SHA the CodeBuild runner checks out. MUST be a full 40-char SHA, never a branch/tag: `terraform plan` evaluates data sources with the runner's assumed role, so an unpinned ref would execute whatever was last pushed (#16 delivery-vector)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.codebuild_source_version))
    error_message = "codebuild_source_version must be a full 40-character git commit SHA (not a branch or tag)."
  }
}

variable "runner_root_dir" {
  description = "Path (relative to the checked-out repo root) of the Terraform runner-root config that instantiates the golden-bucket module. The buildspec `cd`s here before init/plan/apply."
  type        = string
  default     = "terraform/modules/provisioner/runner"
}

variable "terraform_version" {
  description = "Terraform version the CodeBuild runner installs (pinned; matches docs/ci.md)."
  type        = string
  default     = "1.9.8"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.terraform_version))
    error_message = "terraform_version must be a pinned semantic version (e.g. 1.9.8)."
  }
}

variable "codebuild_compute_type" {
  description = "CodeBuild compute type for the runner."
  type        = string
  default     = "BUILD_GENERAL1_SMALL"
}

variable "codebuild_concurrent_build_limit" {
  description = "Maximum number of CodeBuild runs that may execute simultaneously. Bounds provisioning concurrency so the shared state-lock table and account KMS/S3 API limits are not overwhelmed (ADR-0001: 'Concurrent runs must be bounded to avoid state-lock contention')."
  type        = number
  default     = 5

  validation {
    condition     = var.codebuild_concurrent_build_limit >= 1 && var.codebuild_concurrent_build_limit <= 100
    error_message = "codebuild_concurrent_build_limit must be between 1 and 100."
  }
}

# --- SLO / timeouts ---------------------------------------------------------

variable "execution_timeout_seconds" {
  description = "Top-level Step Functions execution timeout. Enforces the 10-minute provisioning SLO (ADR-0001). Must be <= 600."
  type        = number
  default     = 600

  validation {
    condition     = var.execution_timeout_seconds >= 60 && var.execution_timeout_seconds <= 600
    error_message = "execution_timeout_seconds must be between 60 and 600 (the 10-minute SLO ceiling)."
  }
}

variable "codebuild_task_timeout_seconds" {
  description = "Timeout for the RunCodeBuild task (the terraform apply). Must be strictly less than execution_timeout_seconds to leave headroom for the terminal status write."
  type        = number
  default     = 540

  validation {
    condition     = var.codebuild_task_timeout_seconds >= 60 && var.codebuild_task_timeout_seconds <= 3600
    error_message = "codebuild_task_timeout_seconds must be between 60 and 3600."
  }
}

variable "codebuild_build_timeout_minutes" {
  description = "CodeBuild project hard build timeout (minutes). A backstop above the Step Functions task timeout."
  type        = number
  default     = 15

  validation {
    condition     = var.codebuild_build_timeout_minutes >= 5 && var.codebuild_build_timeout_minutes <= 60
    error_message = "codebuild_build_timeout_minutes must be between 5 and 60."
  }
}

# --- glue Lambda ------------------------------------------------------------

variable "lambda_memory_mb" {
  description = "Memory (MB) for the glue (render/validate) Lambda."
  type        = number
  default     = 256

  validation {
    condition     = var.lambda_memory_mb >= 128 && var.lambda_memory_mb <= 10240
    error_message = "lambda_memory_mb must be between 128 and 10240."
  }
}

variable "lambda_timeout_seconds" {
  description = "Timeout (seconds) for the glue Lambda."
  type        = number
  default     = 30

  validation {
    condition     = var.lambda_timeout_seconds >= 1 && var.lambda_timeout_seconds <= 900
    error_message = "lambda_timeout_seconds must be between 1 and 900."
  }
}

variable "lambda_source_dir" {
  description = "Path to the built glue Lambda bundle to package. Defaults to a committed placeholder handler so `terraform validate`/plan works without a build step; a live deploy points this at the compiled dist/ of src/provisioner-glue."
  type        = string
  default     = ""
}

# --- observability / auditing -----------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention (days) for all provisioner log groups."
  type        = number
  default     = 365

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a value accepted by CloudWatch Logs."
  }
}

variable "kms_deletion_window_days" {
  description = "Waiting period (days) before AWS deletes a module-managed KMS key after scheduling."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

variable "enable_state_bucket_audit_trail" {
  description = <<-EOT
    When true (default), create an interim CloudTrail that records S3 object-level
    data events for the state bucket, closing the 'no unaudited window once state
    is written live' gap (#9 iac-5) until the observability module (#23) wires
    server access logging on the state bucket. Set to false once #23 lands.
  EOT
  type        = bool
  default     = true
}

variable "alarm_sns_topic_arns" {
  description = "Optional SNS topic ARNs notified when a provisioning execution fails (DLQ depth > 0). Empty by default; the DLQ alarm still fires and is visible in CloudWatch."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to all resources created by this module."
  type        = map(string)
  default     = {}
}
