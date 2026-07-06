# METADATA
# title: Bucket-request golden-vs-escape classifier
# description: |
#   Deterministically classifies an S3 bucket-provision request as "golden"
#   (auto-provisionable paved road) or "escape" (human approval required).
#
#   The decision interface is a single object:
#
#       data.bucket_broker.classifier.decision = {
#         "classification": "golden" | "escape",
#         "reasons":        [sorted list of matched escape triggers],
#       }
#
#   FAIL-CLOSED CONTRACT (most important property): the default classification
#   is "escape". A request is "golden" only when the input is a well-formed
#   object that matches EVERY golden-baseline criterion and trips NO escape
#   trigger. Any malformed, missing, unknown, or off-baseline input yields at
#   least one reason, and any non-empty reason set forces "escape".
package bucket_broker.classifier

# ---------------------------------------------------------------------------
# Golden baseline configuration
# ---------------------------------------------------------------------------

# Regions the platform paves. Anything else is an escape.
standard_regions := {"us-east-1", "us-east-2", "us-west-2"}

# The only encryption posture on the golden path: an SSE-KMS bucket backed by
# the platform-managed CMK. Every other posture (customer-supplied CMK,
# SSE-S3 / AWS-managed keys, no encryption) is a custom-CMK escape.
golden_encryption_types := {"platform_cmk"}

# Canned ACLs that grant access beyond the bucket owner.
public_acls := {
	"public-read",
	"public-read-write",
	"authenticated-read",
	"log-delivery-write",
}

# The four Block-Public-Access flags. All must be true for the golden path.
bpa_flags := {
	"block_public_acls",
	"block_public_policy",
	"ignore_public_acls",
	"restrict_public_buckets",
}

# Fields a well-formed request must carry. A request missing any of these is
# malformed and therefore an escape.
required_fields := {
	"bucket_name",
	"team",
	"owner",
	"cost_center",
	"region",
	"account_id",
	"versioning",
	"block_public_access",
	"encryption",
}

# Fields a request is permitted to carry. Any key outside this set is an
# unknown field and therefore an escape (a request shape we do not understand
# cannot be certified golden).
allowed_fields := required_fields | {"acl", "bucket_policy"}

# ---------------------------------------------------------------------------
# Decision interface
# ---------------------------------------------------------------------------

# The public decision object. `reasons` is sorted for deterministic output.
decision := {
	"classification": classification,
	"reasons": sort([r | some r in escape_reason]),
}

# Fail-closed default: absent a positive golden determination, escape.
default classification := "escape"

# Golden is the ONLY affirmative outcome, and only when zero triggers fired.
classification := "golden" if count(escape_reason) == 0

# ---------------------------------------------------------------------------
# Structural validation (fail-closed on shape)
# ---------------------------------------------------------------------------

# Set of top-level keys, computed only when input is an object.
input_keys := {k | some k, _ in input} if is_object(input)

# Input that is not an object at all (null, string, array, number, missing).
escape_reason contains "malformed_input" if not is_object(input)

# A well-formed object is missing one or more required fields.
escape_reason contains "malformed_input" if {
	is_object(input)
	count(required_fields - input_keys) > 0
}

# The object carries a key we do not recognise.
escape_reason contains "unknown_field" if {
	is_object(input)
	count(input_keys - allowed_fields) > 0
}

# ---------------------------------------------------------------------------
# Escape trigger: public access
# ---------------------------------------------------------------------------

# Any BPA flag not explicitly true (missing, false, or wrong type).
escape_reason contains "public_access" if {
	is_object(input)
	is_object(input.block_public_access)
	some flag in bpa_flags
	input.block_public_access[flag] != true
}

# block_public_access present but not an object => cannot prove it blocks.
escape_reason contains "public_access" if {
	is_object(input)
	"block_public_access" in input_keys
	not is_object(input.block_public_access)
}

# A public / cross-owner canned ACL.
escape_reason contains "public_access" if {
	is_object(input)
	input.acl in public_acls
}

# A bucket policy statement that grants a wildcard ("*") principal.
escape_reason contains "public_access" if {
	is_object(input)
	some stmt in policy_statements
	"*" in principal_aws_values(stmt.Principal)
}

# ---------------------------------------------------------------------------
# Escape trigger: custom / cross-account bucket policy
# ---------------------------------------------------------------------------

# Presence of ANY caller-supplied bucket policy is an escape: the golden path
# uses only the module's standard, generated policy.
escape_reason contains "custom_bucket_policy" if {
	is_object(input)
	"bucket_policy" in input_keys
	input.bucket_policy != null
}

# A statement naming a concrete principal in a different AWS account.
escape_reason contains "cross_account_access" if {
	is_object(input)
	some stmt in policy_statements
	some principal in principal_aws_values(stmt.Principal)
	principal != "*"
	acct := arn_account(principal)
	acct != ""
	acct != input.account_id
}

# ---------------------------------------------------------------------------
# Escape trigger: off-standard region
# ---------------------------------------------------------------------------

escape_reason contains "off_standard_region" if {
	is_object(input)
	is_string(input.region)
	not input.region in standard_regions
}

# region present but not a string (e.g. number, object) — unclassifiable.
escape_reason contains "off_standard_region" if {
	is_object(input)
	"region" in input_keys
	not is_string(input.region)
}

# ---------------------------------------------------------------------------
# Escape trigger: versioning disabled
# ---------------------------------------------------------------------------

# Golden requires versioning === true. Anything else (false, "Suspended",
# missing value, wrong type) is an escape.
escape_reason contains "versioning_disabled" if {
	is_object(input)
	"versioning" in input_keys
	input.versioning != true
}

# ---------------------------------------------------------------------------
# Escape trigger: customer-supplied / non-standard CMK
# ---------------------------------------------------------------------------

# Encryption whose type is anything other than the platform CMK.
escape_reason contains "custom_cmk" if {
	is_object(input)
	is_object(input.encryption)
	not input.encryption.type in golden_encryption_types
}

# encryption present but not an object — cannot prove platform CMK.
escape_reason contains "custom_cmk" if {
	is_object(input)
	"encryption" in input_keys
	not is_object(input.encryption)
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Flatten a request's bucket-policy statements into a set. Only defined when
# bucket_policy is an object whose Statement is an array.
policy_statements contains stmt if {
	is_object(input.bucket_policy)
	is_array(input.bucket_policy.Statement)
	some stmt in input.bucket_policy.Statement
}

# Normalise an IAM Principal into a set of AWS principal strings, covering the
# three shapes S3 accepts: "*", {"AWS": "<arn>"}, {"AWS": ["<arn>", ...]}.
principal_aws_values(principal) := {principal} if is_string(principal)

principal_aws_values(principal) := {principal.AWS} if {
	is_object(principal)
	is_string(principal.AWS)
}

principal_aws_values(principal) := {v | some v in principal.AWS} if {
	is_object(principal)
	is_array(principal.AWS)
}

# Extract the account-id field (5th, zero-indexed 4) from an ARN. Returns ""
# when the value is not an ARN with an account segment.
arn_account(value) := account if {
	is_string(value)
	parts := split(value, ":")
	count(parts) >= 5
	account := parts[4]
	account != ""
}
