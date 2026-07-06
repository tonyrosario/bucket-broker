# ---------------------------------------------------------------------------
# provisioner module tests (mock_provider — no live AWS).
#
# Covers: happy-path plan shape, input validation, and — most importantly — the
# security ACs that are expressed as rendered IAM policy: ABAC per-request
# scoping, state-KMS kms:ViaService pinning, the absence of key-policy/deletion
# powers, and the minimality of the CodeBuild runner role.
# ---------------------------------------------------------------------------

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "AIDAEXAMPLE"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      partition          = "aws"
      dns_suffix         = "amazonaws.com"
      reverse_dns_prefix = "com.amazonaws"
    }
  }
  mock_data "aws_region" {
    defaults = {
      name = "us-east-1"
    }
  }

  # Under `command = apply`, computed ARNs mock to non-ARN strings that fail the
  # provider's ARN validation on service_role / kms_key_arn / etc. Give the
  # ARN-consumed resources valid ARN-shaped defaults.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
    }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock"
    }
  }
}

variables {
  prefix            = "bb-test"
  state_bucket_name = "bb-test-tfstate"
  state_bucket_arn  = "arn:aws:s3:::bb-test-tfstate"
  lock_table_name   = "bb-test-tflock"
  lock_table_arn    = "arn:aws:dynamodb:us-east-1:123456789012:table/bb-test-tflock"
  state_kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  broker_principal_arns = [
    "arn:aws:iam::123456789012:role/bucket-broker-request-handler",
  ]
  codebuild_source_version = "0123456789abcdef0123456789abcdef01234567"
}

run "plan_shape" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.provisioner.name == "bb-test-provisioner"
    error_message = "state machine name should be <prefix>-provisioner"
  }

  assert {
    condition     = aws_codebuild_project.terraform_runner.source_version == "0123456789abcdef0123456789abcdef01234567"
    error_message = "CodeBuild source must be pinned to the supplied immutable commit SHA"
  }

  assert {
    condition     = aws_codebuild_project.terraform_runner.concurrent_build_limit == 5
    error_message = "CodeBuild concurrency must be bounded (default 5)"
  }
}

run "slo_timeout_enforced" {
  command = apply

  # The 10-minute SLO is enforced by the top-level execution TimeoutSeconds.
  assert {
    condition     = strcontains(aws_sfn_state_machine.provisioner.definition, "\"TimeoutSeconds\":600")
    error_message = "state machine must carry a 600s execution timeout (10-min SLO)"
  }

  # DLQ + FAILED path must exist.
  assert {
    condition     = strcontains(aws_sfn_state_machine.provisioner.definition, "SendToDLQ") && strcontains(aws_sfn_state_machine.provisioner.definition, "SetFailed")
    error_message = "failure path must route to the DLQ and write FAILED"
  }
}

run "provisioning_role_is_abac_and_least_privilege" {
  command = apply

  # Exact per-request scoping via the BucketName session tag (not name-* prefix).
  assert {
    condition     = strcontains(aws_iam_role_policy.provisioning.policy, "aws:PrincipalTag/BucketName")
    error_message = "provisioning role must scope bucket actions by the per-request BucketName session tag"
  }

  # State CMK use is pinned to kms:ViaService (#9 iac-1).
  assert {
    condition     = strcontains(aws_iam_role_policy.provisioning.policy, "kms:ViaService")
    error_message = "state-KMS use must be constrained by kms:ViaService"
  }

  # KMS use is bound to the per-request Name tag, never the universal Module tag.
  assert {
    condition     = strcontains(aws_iam_role_policy.provisioning.policy, "aws:ResourceTag/Name") && !strcontains(aws_iam_role_policy.provisioning.policy, "aws:ResourceTag/Module")
    error_message = "KMS use-grants must key off the per-request Name tag, never the universal Module tag"
  }

  # No key-policy rewrite or key deletion power on any key (#16 P0).
  assert {
    condition     = !strcontains(aws_iam_role_policy.provisioning.policy, "kms:PutKeyPolicy") && !strcontains(aws_iam_role_policy.provisioning.policy, "kms:ScheduleKeyDeletion")
    error_message = "provisioning role must never hold kms:PutKeyPolicy or kms:ScheduleKeyDeletion"
  }
}

run "runner_role_is_minimal" {
  command = apply

  # The CodeBuild runner role holds NO direct create/state powers — only logs +
  # assume. Exactness comes entirely from the assumed provisioning role.
  assert {
    condition     = !strcontains(aws_iam_role_policy.codebuild.policy, "s3:CreateBucket") && !strcontains(aws_iam_role_policy.codebuild.policy, "kms:CreateKey")
    error_message = "the CodeBuild runner role must not hold resource-create permissions directly"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.codebuild.policy, "sts:AssumeRole")
    error_message = "the CodeBuild runner role must be able to assume the provisioning role"
  }
}

run "rejects_branch_ref_source" {
  command = plan

  variables {
    codebuild_source_version = "main"
  }

  expect_failures = [var.codebuild_source_version]
}

run "rejects_empty_broker_principals" {
  command = plan

  variables {
    broker_principal_arns = []
  }

  expect_failures = [var.broker_principal_arns]
}
