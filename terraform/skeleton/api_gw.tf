# ---------------------------------------------------------------------------
# API Gateway REST API — skeleton (NO auth, NO WAF per tracer-bullet scope).
#
# Exposes:
#   POST /buckets     → post-buckets Lambda
#   GET  /buckets/{id} → get-bucket Lambda
#
# Auth and WAF are deferred to the platform-api module (#18).
# ---------------------------------------------------------------------------

resource "aws_api_gateway_rest_api" "skeleton" {
  #checkov:skip=CKV_AWS_237:API GW create-before-destroy managed on the deployment resource; REST API lifecycle is not destroy-sensitive for skeleton.
  name        = "${local.prefix}-api"
  description = "Skeleton API for bucket provisioning (tracer bullet — no auth, no WAF)."

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# /buckets
resource "aws_api_gateway_resource" "buckets" {
  rest_api_id = aws_api_gateway_rest_api.skeleton.id
  parent_id   = aws_api_gateway_rest_api.skeleton.root_resource_id
  path_part   = "buckets"
}

# /buckets/{id}
resource "aws_api_gateway_resource" "bucket_id" {
  rest_api_id = aws_api_gateway_rest_api.skeleton.id
  parent_id   = aws_api_gateway_resource.buckets.id
  path_part   = "{id}"
}

# POST /buckets
resource "aws_api_gateway_method" "post_buckets" { # tfsec:ignore:aws-api-gateway-no-public-access
  #checkov:skip=CKV2_AWS_53:Request validation not required for skeleton; schema validation deferred to platform-api module (#18).
  #checkov:skip=CKV_AWS_59:No auth by design for skeleton endpoint; full auth deferred to platform-api module (#18).
  rest_api_id   = aws_api_gateway_rest_api.skeleton.id
  resource_id   = aws_api_gateway_resource.buckets.id
  http_method   = "POST"
  authorization = "NONE" # No auth per skeleton scope; auth deferred to platform-api module (#18).
}

resource "aws_api_gateway_integration" "post_buckets" {
  rest_api_id             = aws_api_gateway_rest_api.skeleton.id
  resource_id             = aws_api_gateway_resource.buckets.id
  http_method             = aws_api_gateway_method.post_buckets.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.post_buckets.invoke_arn
}

# GET /buckets/{id}
resource "aws_api_gateway_method" "get_bucket" { # tfsec:ignore:aws-api-gateway-no-public-access
  #checkov:skip=CKV2_AWS_53:Request validation not required for skeleton; schema validation deferred to platform-api module (#18).
  #checkov:skip=CKV_AWS_59:No auth by design for skeleton endpoint; full auth deferred to platform-api module (#18).
  rest_api_id   = aws_api_gateway_rest_api.skeleton.id
  resource_id   = aws_api_gateway_resource.bucket_id.id
  http_method   = "GET"
  authorization = "NONE" # No auth per skeleton scope; auth deferred to platform-api module (#18).
}

resource "aws_api_gateway_integration" "get_bucket" {
  rest_api_id             = aws_api_gateway_rest_api.skeleton.id
  resource_id             = aws_api_gateway_resource.bucket_id.id
  http_method             = aws_api_gateway_method.get_bucket.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_bucket.invoke_arn
}

# Deployment and stage
resource "aws_api_gateway_deployment" "skeleton" {
  rest_api_id = aws_api_gateway_rest_api.skeleton.id

  depends_on = [
    aws_api_gateway_integration.post_buckets,
    aws_api_gateway_integration.get_bucket,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "skeleton" { # tfsec:ignore:aws-api-gateway-enable-tracing
  #checkov:skip=CKV2_AWS_29:WAF deferred to platform-api module (#18); skeleton is a build/plan-only tracer bullet with no live traffic.
  #checkov:skip=CKV_AWS_76:Access logging IS configured via access_log_settings below; checkov may not recognize the nested attribute in all versions.
  #checkov:skip=CKV2_AWS_51:Client certificates not required for skeleton; auth hardening is tracked in the platform-api module (#18).
  #checkov:skip=CKV_AWS_73:X-Ray tracing deferred to observability module (#23); skeleton uses inline structured logging only.
  #checkov:skip=CKV_AWS_120:Response caching not required for skeleton; caching adds cost and complexity for a tracer bullet.
  #checkov:skip=CKV_AWS_225:Response caching not required for skeleton; caching adds cost and complexity for a tracer bullet.
  #checkov:skip=CKV_AWS_59:No auth by design for this skeleton endpoint; full auth deferred to platform-api module (#18).
  #checkov:skip=CKV_AWS_237:API GW create-before-destroy managed on the deployment resource; stage lifecycle is not destroy-sensitive for skeleton.
  deployment_id = aws_api_gateway_deployment.skeleton.id
  rest_api_id   = aws_api_gateway_rest_api.skeleton.id
  stage_name    = "v1"
  description   = "Skeleton API stage v1. X-Ray tracing deferred to observability module (#23)."

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.resourcePath"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      correlationId  = "$context.requestId"
    })
  }

  depends_on = [aws_api_gateway_account.skeleton]
}

# Stage-level method settings: throttle + logging
# Response caching is disabled: not required for skeleton (adds cost + complexity).
resource "aws_api_gateway_method_settings" "all" { # tfsec:ignore:aws-api-gateway-enable-cache
  #checkov:skip=CKV_AWS_225:Response caching not required for skeleton; caching adds cost and complexity for a tracer bullet.
  rest_api_id = aws_api_gateway_rest_api.skeleton.id
  stage_name  = aws_api_gateway_stage.skeleton.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled        = true
    logging_level          = "INFO"
    data_trace_enabled     = false # Avoid logging request bodies in CloudWatch
    throttling_rate_limit  = 100
    throttling_burst_limit = 50
  }
}
