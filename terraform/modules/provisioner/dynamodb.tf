# ---------------------------------------------------------------------------
# Status table — provision request lifecycle.
#
# Item shape: requestId (PK, S), status (S), correlationId (S), timestamps.
# Status lifecycle:  PENDING -> PROVISIONING -> READY | FAILED
#   PENDING       written by the request-handler (#19) at StartExecution.
#   PROVISIONING  written by the glue Lambda (idempotent conditional update).
#   READY/FAILED  written by Step Functions (native DynamoDB updateItem),
#                 each guarded by a ConditionExpression so re-runs are safe.
#
# Encrypted with the module `data` key (NOT the state key), PITR enabled, TTL
# for eventual cleanup of terminal records.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "status" {
  name         = "${local.prefix}-requests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "requestId"

  attribute {
    name = "requestId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = local.tags
}
