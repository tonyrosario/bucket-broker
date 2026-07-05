# ---------------------------------------------------------------------------
# Example variables — all have defaults suitable for a demo/dev run.
# Override via terraform.tfvars or -var flags in a real environment.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for the example deployment."
  type        = string
  default     = "us-east-1"
}

variable "oidc_provider_arn" {
  description = "ARN of the pre-existing AWS IAM OIDC identity provider for the IdP. Create this once per AWS account before calling this module."
  type        = string
  # EXAMPLE default — replace with your real OIDC provider ARN.
  # Format: arn:aws:iam::<account-id>:oidc-provider/<issuer-host>
  default = "arn:aws:iam::123456789012:oidc-provider/dev-12345.example-idp.com"
}
