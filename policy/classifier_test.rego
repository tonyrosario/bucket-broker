package bucket_broker.classifier_test

import data.bucket_broker.classifier

# ---------------------------------------------------------------------------
# Golden baseline fixture — the canonical paved-road request. Every escape
# test below is this object with exactly one field mutated, so each test
# isolates a single trigger.
# ---------------------------------------------------------------------------

golden_request := {
	"bucket_name": "acme-platform-data-prod",
	"team": "platform",
	"owner": "platform@acme.example.com",
	"cost_center": "CC-1234",
	"region": "us-east-1",
	"account_id": "123456789012",
	"versioning": true,
	"block_public_access": {
		"block_public_acls": true,
		"block_public_policy": true,
		"ignore_public_acls": true,
		"restrict_public_buckets": true,
	},
	"encryption": {
		"type": "platform_cmk",
		"key_arn": "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab",
	},
}

# ---------------------------------------------------------------------------
# Golden baseline
# ---------------------------------------------------------------------------

test_golden_baseline_is_golden if {
	decision := classifier.decision with input as golden_request
	decision.classification == "golden"
	decision.reasons == []
}

test_golden_with_optional_private_acl_is_golden if {
	decision := classifier.decision with input as object.union(golden_request, {"acl": "private"})
	decision.classification == "golden"
}

# ---------------------------------------------------------------------------
# Escape trigger: public access
# ---------------------------------------------------------------------------

test_escape_bpa_flag_disabled if {
	decision := classifier.decision with input as object.union(golden_request, {"block_public_access": {
		"block_public_acls": false,
		"block_public_policy": true,
		"ignore_public_acls": true,
		"restrict_public_buckets": true,
	}})
	decision.classification == "escape"
	"public_access" in decision.reasons
}

test_escape_bpa_not_an_object if {
	decision := classifier.decision with input as object.union(golden_request, {"block_public_access": "yes"})
	decision.classification == "escape"
	"public_access" in decision.reasons
}

test_escape_public_acl if {
	decision := classifier.decision with input as object.union(golden_request, {"acl": "public-read"})
	decision.classification == "escape"
	"public_access" in decision.reasons
}

test_escape_public_bucket_policy_wildcard_principal if {
	decision := classifier.decision with input as object.union(golden_request, {"bucket_policy": {"Version": "2012-10-17", "Statement": [{
		"Effect": "Allow",
		"Principal": "*",
		"Action": "s3:GetObject",
		"Resource": "arn:aws:s3:::acme-platform-data-prod/*",
	}]}})
	decision.classification == "escape"
	"public_access" in decision.reasons
}

# ---------------------------------------------------------------------------
# Escape trigger: custom / cross-account bucket policy
# ---------------------------------------------------------------------------

test_escape_custom_bucket_policy if {
	decision := classifier.decision with input as object.union(golden_request, {"bucket_policy": {"Version": "2012-10-17", "Statement": [{
		"Effect": "Allow",
		"Principal": {"AWS": "arn:aws:iam::123456789012:role/team-platform"},
		"Action": "s3:GetObject",
		"Resource": "arn:aws:s3:::acme-platform-data-prod/*",
	}]}})
	decision.classification == "escape"
	"custom_bucket_policy" in decision.reasons
}

test_escape_cross_account_principal if {
	decision := classifier.decision with input as object.union(golden_request, {"bucket_policy": {"Version": "2012-10-17", "Statement": [{
		"Effect": "Allow",
		"Principal": {"AWS": "arn:aws:iam::999888777666:role/foreign-team"},
		"Action": "s3:GetObject",
		"Resource": "arn:aws:s3:::acme-platform-data-prod/*",
	}]}})
	decision.classification == "escape"
	"cross_account_access" in decision.reasons
}

test_cross_account_detects_principal_in_array if {
	decision := classifier.decision with input as object.union(golden_request, {"bucket_policy": {"Version": "2012-10-17", "Statement": [{
		"Effect": "Allow",
		"Principal": {"AWS": [
			"arn:aws:iam::123456789012:role/team-platform",
			"arn:aws:iam::999888777666:role/foreign-team",
		]},
		"Action": "s3:GetObject",
		"Resource": "arn:aws:s3:::acme-platform-data-prod/*",
	}]}})
	"cross_account_access" in decision.reasons
}

test_same_account_policy_is_not_cross_account if {
	decision := classifier.decision with input as object.union(golden_request, {"bucket_policy": {"Version": "2012-10-17", "Statement": [{
		"Effect": "Allow",
		"Principal": {"AWS": "arn:aws:iam::123456789012:role/team-platform"},
		"Action": "s3:GetObject",
		"Resource": "arn:aws:s3:::acme-platform-data-prod/*",
	}]}})
	not "cross_account_access" in decision.reasons
}

# ---------------------------------------------------------------------------
# Escape trigger: off-standard region
# ---------------------------------------------------------------------------

test_escape_off_standard_region if {
	decision := classifier.decision with input as object.union(golden_request, {"region": "eu-west-1"})
	decision.classification == "escape"
	"off_standard_region" in decision.reasons
}

test_escape_region_wrong_type if {
	decision := classifier.decision with input as object.union(golden_request, {"region": 12345})
	decision.classification == "escape"
	"off_standard_region" in decision.reasons
}

# ---------------------------------------------------------------------------
# Escape trigger: versioning disabled
# ---------------------------------------------------------------------------

test_escape_versioning_disabled if {
	decision := classifier.decision with input as object.union(golden_request, {"versioning": false})
	decision.classification == "escape"
	"versioning_disabled" in decision.reasons
}

test_escape_versioning_suspended_string if {
	decision := classifier.decision with input as object.union(golden_request, {"versioning": "Suspended"})
	decision.classification == "escape"
	"versioning_disabled" in decision.reasons
}

# ---------------------------------------------------------------------------
# Escape trigger: customer-supplied / non-standard CMK
# ---------------------------------------------------------------------------

test_escape_customer_cmk if {
	decision := classifier.decision with input as object.union(golden_request, {"encryption": {
		"type": "customer_cmk",
		"key_arn": "arn:aws:kms:us-east-1:123456789012:key/deadbeef-dead-beef-dead-beefdeadbeef",
	}})
	decision.classification == "escape"
	"custom_cmk" in decision.reasons
}

test_escape_aws_managed_encryption_is_non_golden if {
	decision := classifier.decision with input as object.union(golden_request, {"encryption": {"type": "aws_managed"}})
	decision.classification == "escape"
	"custom_cmk" in decision.reasons
}

test_escape_encryption_not_an_object if {
	decision := classifier.decision with input as object.union(golden_request, {"encryption": "aws:kms"})
	decision.classification == "escape"
	"custom_cmk" in decision.reasons
}

# ---------------------------------------------------------------------------
# Fail-closed: malformed / unknown / missing / empty input defaults to escape
# ---------------------------------------------------------------------------

test_fail_closed_empty_object if {
	decision := classifier.decision with input as {}
	decision.classification == "escape"
	"malformed_input" in decision.reasons
}

test_fail_closed_null_input if {
	decision := classifier.decision with input as null
	decision.classification == "escape"
	"malformed_input" in decision.reasons
}

test_fail_closed_string_input if {
	decision := classifier.decision with input as "not-a-request"
	decision.classification == "escape"
	"malformed_input" in decision.reasons
}

test_fail_closed_array_input if {
	decision := classifier.decision with input as [1, 2, 3]
	decision.classification == "escape"
	"malformed_input" in decision.reasons
}

test_fail_closed_missing_required_field if {
	decision := classifier.decision with input as object.remove(golden_request, {"encryption"})
	decision.classification == "escape"
	"malformed_input" in decision.reasons
}

test_fail_closed_unknown_field if {
	decision := classifier.decision with input as object.union(golden_request, {"replication": {"enabled": true}})
	decision.classification == "escape"
	"unknown_field" in decision.reasons
}

# ---------------------------------------------------------------------------
# Determinism: multiple triggers accumulate into a sorted reason list
# ---------------------------------------------------------------------------

test_multiple_triggers_accumulate_sorted if {
	decision := classifier.decision with input as object.union(golden_request, {
		"region": "eu-west-1",
		"versioning": false,
	})
	decision.classification == "escape"
	decision.reasons == ["off_standard_region", "versioning_disabled"]
}
