# ---------------------------------------------------------------------------
# DynamoDB lock table — standard Terraform state-locking schema (LockID PK).
# Encrypted with the module's KMS CMK; PITR enabled for safety.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "lock" {
  name         = "${var.prefix}-tflock"
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
    kms_key_arn = aws_kms_key.state.arn
  }

  tags = var.tags
}
