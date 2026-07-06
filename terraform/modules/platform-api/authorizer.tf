# ---------------------------------------------------------------------------
# JWT authorizer Lambda + least-privilege IAM (issue #17).
#
# The function code lives in src/authorizer (Node.js 20 / TypeScript, ADR-0005).
# It validates a bearer JWT's signature/issuer/audience/exp/nbf against JWKS
# keys cached with stale-while-revalidate behind the shared resilience helper,
# fails closed on any doubt, and forwards identity + group claims downstream for
# platform-brokered authorization (ADR-0006).
# ---------------------------------------------------------------------------

# --- Execution role --------------------------------------------------------

data "aws_iam_policy_document" "authorizer_assume" {
  statement {
    sid     = "LambdaAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "authorizer" {
  name               = "${var.name_prefix}-jwt-authorizer"
  description        = "Execution role for the JWT authorizer Lambda. Least privilege: read the OIDC SSM params, decrypt them with the identity CMK, and write its own logs — nothing else."
  assume_role_policy = data.aws_iam_policy_document.authorizer_assume.json

  tags = local.tags
}

# --- Least-privilege permissions -------------------------------------------

data "aws_iam_policy_document" "authorizer_permissions" {
  # Read ONLY the three OIDC parameters, by exact ARN. No ssm:* wildcard, no
  # path wildcard beyond the specific parameters the authorizer needs.
  statement {
    sid       = "ReadOidcParameters"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = var.ssm_oidc_parameter_arns
  }

  # Decrypt ONLY the identity CMK — required to read the SecureString JWKS URI.
  statement {
    sid       = "DecryptOidcSecureString"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.oidc_kms_key_arn]
  }

  # Write ONLY to this function's own log group / streams. The group itself is
  # pre-created (with CMK encryption) below, so CreateLogGroup is not granted.
  # The trailing ":*" scopes to the log STREAMS inside this one group — it is
  # not an open wildcard. CloudWatch Logs stream names are created dynamically
  # per Lambda container, so enumerating them is impossible; this is the
  # tightest expressible scope. (tfsec flags any "*"; suppressed with cause.)
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    #tfsec:ignore:aws-iam-no-policy-wildcards
    resources = ["${local.log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "authorizer" {
  name   = "${var.name_prefix}-jwt-authorizer"
  role   = aws_iam_role.authorizer.id
  policy = data.aws_iam_policy_document.authorizer_permissions.json
}

# --- Log group (CMK-encrypted, pre-created so the role needs no CreateLogGroup)

resource "aws_cloudwatch_log_group" "authorizer" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.tags
}

# --- The authorizer Lambda -------------------------------------------------

resource "aws_lambda_function" "authorizer" {
  # checkov:skip=CKV_AWS_116:A Lambda DLQ applies only to ASYNC invocations. An API Gateway REQUEST authorizer is invoked synchronously; there is no async event to dead-letter.
  # checkov:skip=CKV_AWS_117:The authorizer needs public egress to reach the IdP's JWKS endpoint. Running it in a VPC would require NAT for no security gain; no VPC resources are in scope for #17.
  # checkov:skip=CKV_AWS_173:Environment variables here are non-secret SSM parameter NAMES only. The actual OIDC values are SecureString params fetched at runtime (KMS-decrypted); nothing sensitive is stored in the Lambda env.
  # checkov:skip=CKV_AWS_272:Code-signing (Signer) is deferred to the hardening milestone (#24); it is not part of the #17 authorizer slice.
  function_name = local.function_name
  description   = "API Gateway REQUEST authorizer: validate JWT vs cached JWKS, fail-closed (ADR-0004). Forwards identity+groups for platform-brokered authz (ADR-0006)."
  role          = aws_iam_role.authorizer.arn
  handler       = var.lambda_handler
  runtime       = var.lambda_runtime
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  reserved_concurrent_executions = var.reserved_concurrent_executions

  filename         = var.lambda_package_path
  source_code_hash = try(filebase64sha256(var.lambda_package_path), null)

  environment {
    variables = local.environment
  }

  # End-to-end X-Ray tracing (architecture cross-cutting requirement).
  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_iam_role_policy.authorizer,
    aws_cloudwatch_log_group.authorizer,
  ]

  tags = local.tags
}
