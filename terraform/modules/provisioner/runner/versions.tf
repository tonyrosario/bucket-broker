terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial backend — the CodeBuild runner supplies bucket/key/region/
  # dynamodb_table/kms_key_id via `-backend-config` per request so each
  # provision writes to an isolated, KMS-encrypted, lock-protected state key.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}
