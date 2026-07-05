terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Skeleton-owned S3 + DynamoDB backend (NOT modules/state-backend).
  # Bootstrap: on first apply, comment this block out and use local state
  # to create the state bucket + lock table, then uncomment and re-init.
  backend "s3" {
    bucket         = "bucket-broker-skeleton-tfstate"
    key            = "skeleton/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "bucket-broker-skeleton-tflock"
    encrypt        = true
    # kms_key_id is set via -backend-config or workspace config after bootstrap
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "bucket-broker"
      Module    = "skeleton"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  prefix     = "skeleton"
}
