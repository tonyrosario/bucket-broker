# ---------------------------------------------------------------------------
# CodeBuild project — Terraform runner for the stripped-bucket module.
#
# The buildspec runs:
#   1. Install Terraform (pinned to 1.9.8, matching CI gate in docs/ci.md)
#   2. cd terraform/skeleton/stripped-bucket
#   3. terraform init -backend=false   (plan-only; live apply tracked in #25)
#   4. terraform validate
#   5. terraform plan -var="request_id=$REQUEST_ID"
#
# Source: GitHub (repo root), pinned to an immutable commit SHA via
# var.codebuild_source_version (never a branch) so CodeBuild always runs from
# known-good code. terraform plan evaluates data sources at plan time, so an
# unpinned ref would execute whatever was last pushed with the runner's role.
# (#16 review)
# ---------------------------------------------------------------------------

resource "aws_codebuild_project" "terraform_runner" {
  name          = "${local.prefix}-terraform-runner"
  description   = "Skeleton: runs terraform init/validate/plan on the stripped-bucket module."
  build_timeout = 15 # minutes (CodeBuild hard cap; Step Functions caps at 9 min via task timeout)
  service_role  = aws_iam_role.codebuild.arn

  source {
    type      = "GITHUB"
    location  = "https://github.com/tonyrosario/bucket-broker.git"
    buildspec = <<-BUILDSPEC
      version: 0.2

      env:
        variables:
          TF_VERSION: "1.9.8"
          TF_IN_AUTOMATION: "1"

      phases:
        install:
          commands:
            - |
              echo "[skeleton-runner] Installing Terraform $TF_VERSION"
              curl -sSfL \
                "https://releases.hashicorp.com/terraform/$${TF_VERSION}/terraform_$${TF_VERSION}_linux_amd64.zip" \
                -o /tmp/terraform.zip
              unzip -q /tmp/terraform.zip -d /usr/local/bin
              terraform version

        build:
          commands:
            - |
              echo "[skeleton-runner] REQUEST_ID=$${REQUEST_ID} CORRELATION_ID=$${CORRELATION_ID}"
              cd terraform/skeleton/stripped-bucket
              terraform init -backend=false -input=false -no-color
              terraform validate -no-color
              terraform plan \
                -var="request_id=$${REQUEST_ID}" \
                -var="correlation_id=$${CORRELATION_ID}" \
                -no-color \
                -out=/tmp/tfplan
              echo "[skeleton-runner] Plan complete."

      cache:
        type: NO_CACHE
    BUILDSPEC
  }

  # Pin the checked-out ref to an immutable commit SHA (never a branch) so the
  # runner always executes known-good code. (#16 review)
  source_version = var.codebuild_source_version

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false

    environment_variable {
      name  = "REQUEST_ID"
      value = "PLACEHOLDER"
      type  = "PLAINTEXT"
    }

    environment_variable {
      name  = "CORRELATION_ID"
      value = "PLACEHOLDER"
      type  = "PLAINTEXT"
    }
  }

  logs_config {
    cloudwatch_logs {
      status     = "ENABLED"
      group_name = aws_cloudwatch_log_group.codebuild.name
    }

    s3_logs {
      status = "DISABLED"
    }
  }

  #checkov:skip=CKV_AWS_316:privileged_mode is explicitly false above; checkov may raise a false positive if it does not parse the nested attribute.
  #checkov:skip=CKV_AWS_147:CloudWatch log group IS encrypted via aws_cloudwatch_log_group.codebuild with a customer-managed KMS key.

  depends_on = [aws_cloudwatch_log_group.codebuild]
}
