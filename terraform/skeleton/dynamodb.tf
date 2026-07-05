# ---------------------------------------------------------------------------
# DynamoDB tables
# ---------------------------------------------------------------------------
# requests     — stores provision request records (requestId PK, status, timestamps)
# tfstate_lock — TF state locking for the skeleton's own TF backend
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "requests" {
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
}

resource "aws_dynamodb_table" "tfstate_lock" {
  name         = "bucket-broker-skeleton-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }
}
