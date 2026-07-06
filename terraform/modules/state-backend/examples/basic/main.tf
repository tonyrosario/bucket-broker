# ---------------------------------------------------------------------------
# Example: basic state-backend usage.
#
# This root module shows the minimal configuration to call the state-backend
# module. Apply with local state first (no backend block), then add the
# backend "s3" block and re-init to migrate state into the new bucket.
# See the module README for the full two-step bootstrap procedure.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Step 1: comment the backend block out for the initial bootstrap apply.
  # Step 2: fill in the values from the outputs and uncomment, then re-init.
  #
  # backend "s3" {
  #   bucket         = "acme-dev-tfstate"
  #   key            = "state-backend/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "acme-dev-tflock"
  #   encrypt        = true
  #   kms_key_id     = "arn:aws:kms:us-east-1:123456789012:key/..."
  # }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "acme"
      ManagedBy = "terraform"
    }
  }
}

module "state_backend" {
  source = "../../"

  prefix = "acme-dev"

  tags = {
    Environment = "dev"
    Team        = "platform"
  }

  noncurrent_version_retention_days = 90
  kms_deletion_window_days          = 30

  # Uncomment and set to the ARN of your Terraform runner role once it exists.
  # terraform_state_principals = [
  #   "arn:aws:iam::123456789012:role/acme-dev-codebuild-runner",
  # ]
}
