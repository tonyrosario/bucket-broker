# ---------------------------------------------------------------------------
# Example variables — all have defaults suitable for a demo/dev run.
# Override via terraform.tfvars or -var flags in a real environment.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for the example deployment."
  type        = string
  default     = "us-east-1"
}

variable "broker_principal_arns" {
  description = "Backend principal ARNs (request-handler / provisioner execution roles) allowed to assume team roles after the entitlements check. See ADR-0006."
  type        = list(string)
  # EXAMPLE default — replace with your real backend role ARNs.
  default = ["arn:aws:iam::123456789012:role/bucket-broker-request-handler"]
}
