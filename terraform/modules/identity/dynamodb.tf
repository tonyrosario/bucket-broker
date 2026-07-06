# ---------------------------------------------------------------------------
# DynamoDB — entitlements table.
#
# Schema (PK only; all other attributes are schemaless):
#   group (S) — IdP group name (PK). Examples: "platform-eng", "data-team".
#
# Item shape (application-level schema, not enforced by DynamoDB):
#   group       String  — matches the IdP group claim in the JWT.
#   can_create  Boolean — whether members of this group may provision buckets.
#   teams       List<S> — team identifiers this group administers.
#   access      Map     — {read: Bool, write: Bool, delete: Bool} for all
#                         buckets owned by this group's teams.
#
# This is DATA, not code — swapping Okta for another OIDC IdP means updating
# the 'group' values to match the new IdP's claim names. No Terraform changes.
#
# See examples/complete/main.tf for a sample seed item (demo team).
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "entitlements" {
  name         = local.entitlements_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "group"

  attribute {
    name = "group"
    type = "S"
  }

  # Encrypt all items at rest with the identity CMK.
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.identity.arn
  }

  # Point-in-time recovery — enables restore to any second in the last 35 days.
  # Essential for an authoritative entitlements store.
  point_in_time_recovery {
    enabled = true
  }

  tags = local.tags
}
