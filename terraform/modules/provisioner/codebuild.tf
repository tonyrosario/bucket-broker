# ---------------------------------------------------------------------------
# CodeBuild Terraform runner.
#
# Source is pinned to an immutable commit SHA (var.codebuild_source_version),
# never a branch/tag: `terraform plan` evaluates data sources with the assumed
# provisioning role, so an unpinned ref would run whatever was last pushed
# (#16 delivery-vector).
#
# The buildspec:
#   1. installs the pinned Terraform version;
#   2. assumes the provisioning role, passing the validated BucketName / Team /
#      RequestId as SESSION TAGS (these drive the ABAC scoping in iam.tf);
#   3. writes the glue-rendered JSON tfvars to terraform.auto.tfvars.json — the
#      values are consumed by Terraform's native JSON tfvars loader, never
#      concatenated into HCL (#16 injection note / ADR-0003);
#   4. runs terraform init (S3+DynamoDB backend) / plan / apply on the runner
#      root, which instantiates the golden-bucket module.
# ---------------------------------------------------------------------------

resource "aws_codebuild_project" "terraform_runner" {
  name                   = "${local.prefix}-terraform-runner"
  description            = "Applies the golden-bucket module per request under a per-request ABAC session of the provisioning role."
  build_timeout          = var.codebuild_build_timeout_minutes
  concurrent_build_limit = var.codebuild_concurrent_build_limit
  service_role           = aws_iam_role.codebuild.arn

  #checkov:skip=CKV_AWS_78:Build artifacts are NO_ARTIFACTS and build logs are encrypted via the CloudWatch log group's CMK; no default-S3 artifact key is in play.
  #checkov:skip=CKV_AWS_316:privileged_mode is explicitly false below.

  source {
    type            = "GITHUB"
    location        = var.codebuild_source_location
    git_clone_depth = 1

    buildspec = <<-BUILDSPEC
      version: 0.2

      env:
        variables:
          TF_IN_AUTOMATION: "1"

      phases:
        install:
          commands:
            - |
              set -euo pipefail
              echo "[runner] Installing Terraform $${TF_VERSION} (SHA256 + GPG verified)"
              cd /tmp
              base="https://releases.hashicorp.com/terraform/$${TF_VERSION}"
              zip="terraform_$${TF_VERSION}_linux_amd64.zip"
              sums="terraform_$${TF_VERSION}_SHA256SUMS"
              curl -sSfL "$${base}/$${zip}"        -o "$${zip}"
              curl -sSfL "$${base}/$${sums}"       -o "$${sums}"
              curl -sSfL "$${base}/$${sums}.sig" -o "$${sums}.sig"
              # Import the HashiCorp release-signing PGP key over TLS and PIN its
              # fingerprint: a swapped key would change the fingerprint and fail
              # here, so an attacker cannot forge a matching signature.
              HASHICORP_FPR="C874011F0AB405110D02105534365D9472D7468F"
              curl -sSfL "https://www.hashicorp.com/.well-known/pgp-key.txt" | gpg --batch --import
              gpg --batch --fingerprint "$${HASHICORP_FPR}"
              # Signature over SHA256SUMS must be VALID and made by that exact key.
              gpg --batch --verify --status-fd=1 "$${sums}.sig" "$${sums}" \
                | grep -E "^\[GNUPG:\] VALIDSIG $${HASHICORP_FPR} " >/dev/null
              # Now the checksum file is trusted — verify the zip against it.
              grep " $${zip}$" "$${sums}" | sha256sum -c -
              unzip -q -o "$${zip}" -d /usr/local/bin
              terraform version
        pre_build:
          commands:
            - |
              set -euo pipefail
              echo "[runner] REQUEST_ID=$${REQUEST_ID} CORRELATION_ID=$${CORRELATION_ID}"
              # Assume the provisioning role, passing validated session tags. The
              # tag VALUES were validated + emitted by the glue Lambda; they never
              # reach the shell as anything but STS tag values or a JSON file.
              CREDS=$(aws sts assume-role \
                --role-arn "$${PROVISIONING_ROLE_ARN}" \
                --role-session-name "provision-$${REQUEST_ID}" \
                --tags "Key=BucketName,Value=$${BUCKET_NAME}" "Key=Team,Value=$${TEAM}" "Key=RequestId,Value=$${REQUEST_ID}" \
                --duration-seconds 3600 \
                --query 'Credentials' --output json)
              export AWS_ACCESS_KEY_ID=$(echo "$${CREDS}" | jq -r '.AccessKeyId')
              export AWS_SECRET_ACCESS_KEY=$(echo "$${CREDS}" | jq -r '.SecretAccessKey')
              export AWS_SESSION_TOKEN=$(echo "$${CREDS}" | jq -r '.SessionToken')
              aws sts get-caller-identity
        build:
          commands:
            - |
              set -euo pipefail
              cd "$${RUNNER_ROOT}"
              # tfvars are JSON (from the glue's JSON.stringify) — Terraform reads
              # them via its native *.auto.tfvars.json loader. No HCL concatenation.
              printf '%s' "$${TFVARS_JSON}" > terraform.auto.tfvars.json
              terraform init -input=false -no-color \
                -backend-config="bucket=$${STATE_BUCKET}" \
                -backend-config="key=$${STATE_KEY}" \
                -backend-config="region=$${AWS_DEFAULT_REGION}" \
                -backend-config="dynamodb_table=$${LOCK_TABLE}" \
                -backend-config="kms_key_id=$${STATE_KMS_KEY}" \
                -backend-config="encrypt=true"
              terraform plan -input=false -no-color -out=/tmp/tfplan
              terraform apply -input=false -no-color -auto-approve /tmp/tfplan
              echo "[runner] apply complete for $${BUCKET_NAME}"

      cache:
        type: NO_CACHE
    BUILDSPEC
  }

  source_version = var.codebuild_source_version

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.codebuild_compute_type
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false

    # Static (per-project) configuration. Per-request values (BUCKET_NAME, TEAM,
    # REQUEST_ID, CORRELATION_ID, STATE_KEY, TFVARS_JSON) are injected by Step
    # Functions via EnvironmentVariablesOverride (state_machine.tf).
    environment_variable {
      name  = "TF_VERSION"
      value = var.terraform_version
    }
    environment_variable {
      name  = "PROVISIONING_ROLE_ARN"
      value = aws_iam_role.provisioning.arn
    }
    environment_variable {
      name  = "STATE_BUCKET"
      value = var.state_bucket_name
    }
    environment_variable {
      name  = "LOCK_TABLE"
      value = var.lock_table_name
    }
    environment_variable {
      name  = "STATE_KMS_KEY"
      value = var.state_kms_key_arn
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "RUNNER_ROOT"
      value = var.runner_root_dir
    }
    # Overridden per request; placeholder keeps the project definition valid.
    environment_variable {
      name  = "BUCKET_NAME"
      value = "PLACEHOLDER"
    }
    environment_variable {
      name  = "TEAM"
      value = "PLACEHOLDER"
    }
    environment_variable {
      name  = "REQUEST_ID"
      value = "PLACEHOLDER"
    }
    environment_variable {
      name  = "CORRELATION_ID"
      value = "PLACEHOLDER"
    }
    environment_variable {
      name  = "STATE_KEY"
      value = "PLACEHOLDER"
    }
    environment_variable {
      name  = "TFVARS_JSON"
      value = "PLACEHOLDER"
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

  depends_on = [aws_cloudwatch_log_group.codebuild]
}
