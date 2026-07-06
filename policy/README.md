# policy — golden-vs-escape classifier (OPA / Rego)

Deterministic OPA/Rego policy that classifies an S3 bucket-provision request as
**golden** (auto-provisionable paved road) or **escape** (human approval
required). It is the OPA "classify" step in the request flow
(`docs/design/architecture.md`) and the `modules/policy` responsibility.

- Package: `bucket_broker.classifier`
- Decision entrypoint: `data.bucket_broker.classifier.decision`
- Files: [`classifier.rego`](classifier.rego), [`classifier_test.rego`](classifier_test.rego)

## Decision interface

A single object, so callers depend on one stable contract:

```json
{
  "classification": "golden" | "escape",
  "reasons": ["<sorted escape triggers>"]
}
```

`reasons` is empty for golden and a sorted, deterministic list of the matched
triggers for escape.

## Input schema

The classifier evaluates the request `input`:

| Field | Type | Required | Golden value |
|-------|------|----------|--------------|
| `bucket_name` | string | yes | any |
| `team` | string | yes | any |
| `owner` | string | yes | any |
| `cost_center` | string | yes | any |
| `region` | string | yes | one of the standard regions |
| `account_id` | string | yes | the platform account (used for cross-account detection) |
| `versioning` | bool | yes | `true` |
| `block_public_access` | object | yes | all four flags `true` |
| `encryption` | object | yes | `{ "type": "platform_cmk", ... }` |
| `acl` | string | no | absent or `private` (case-insensitive); any other value escapes |
| `bucket_policy` | object | no | absent or `null` (golden path uses the module's generated policy only; any non-null value escapes) |

`block_public_access` object: `block_public_acls`, `block_public_policy`,
`ignore_public_acls`, `restrict_public_buckets` — all must be `true`.

Any **unknown** top-level field, any **missing** required field, or a
non-object `input` makes the request malformed → escape (see fail-closed).

## Golden baseline

A request is golden **only** when it is a well-formed object that matches every
criterion and trips no trigger:

- `region` ∈ `{us-east-1, us-east-2, us-west-2}`
- `versioning` === `true`
- all four Block-Public-Access flags **present and** === `true` (a missing flag
  fails closed to `public_access`, not golden)
- `acl` allowlist: absent or exactly `private` (case-insensitive). Any other
  value — off-list canned ACLs (`aws-exec-read`, `bucket-owner-full-control`),
  casing variants, or a non-string `acl` — is `public_access`
- no non-null caller-supplied `bucket_policy`
- `encryption.type` === `platform_cmk` (platform-managed CMK)
- no unknown fields

These mirror the controls the `golden-bucket` Terraform module enforces
(SSE-KMS with the module CMK, BPA, versioning, standard region, generated
TLS-only policy).

## Escape triggers (each has a test)

| Reason | Fires when |
|--------|-----------|
| `public_access` | any of the four BPA flags missing or not exactly `true` (or BPA not an object), an `acl` that is present and not exactly `private` (case-insensitive) — including non-string acl and casing variants — or a bucket-policy statement with a `"*"` principal |
| `custom_bucket_policy` | any caller-supplied `bucket_policy` that is non-null (mere presence with `null` value does not trip) |
| `cross_account_access` | a bucket-policy principal ARN names a different AWS account than `account_id` |
| `off_standard_region` | `region` not in the standard set (or not a string) |
| `versioning_disabled` | `versioning` is anything other than `true` |
| `custom_cmk` | `encryption.type` is not `platform_cmk` (customer CMK, SSE-S3/AWS-managed, or non-object) |
| `unknown_field` | request carries a key outside the allowed set |
| `malformed_input` | `input` is not an object, or a required field is missing |

## Fail-closed default (the load-bearing property)

The default classification is **escape**, declared explicitly:

```rego
default classification := "escape"
classification := "golden" if count(escape_reason) == 0
```

`golden` is the only affirmative outcome and is reachable only when the
`escape_reason` set is empty. Because every structural problem
(non-object input, missing required field, unknown field) contributes a reason,
an unclassifiable or malformed request can never be certified golden — it falls
through to the `escape` default. This is verified by dedicated tests for empty
`{}`, `null`, string, and array input, a missing required field, and an unknown
field.

## Running the gates (same as CI, `docs/ci.md`)

Pinned OPA version: **1.18.2**.

```shell
opa fmt --list --fail policy     # formatting gate (must list nothing)
opa test policy -v               # policy test suite
```

## In-process / bundled consumption (ADR-0004, no network hop)

Per ADR-0004 the policy engine is **in-process/bundled** — there is no remote
OPA server and no network hop on the hot path. The request-handler Lambda loads
this policy as an OPA bundle and evaluates it locally.

Build the runtime bundle with the decision entrypoint baked into the manifest:

```shell
# WASM bundle for the Node/TypeScript Lambdas (ADR-0005), evaluated in-process
# via @open-policy-agent/opa-wasm — zero network calls:
opa build -t wasm -b policy \
  -e bucket_broker/classifier/decision \
  --ignore '*_test.rego' \
  -o dist/policy-bundle.tar.gz
```

The Lambda instantiates the WASM module once per container, then calls it per
request with the bucket-request `input`, reading back the `decision` object.
`golden` starts the Step Functions provisioning execution; `escape` routes to
the approval flow with `reasons` recorded in the escape-audit log.

A plain (non-WASM) bundle is equally valid for a host with an embedded OPA
(e.g. the Go SDK / `opa eval --bundle`) and is the form used to sanity-check the
entrypoint locally:

```shell
opa build -b policy -e bucket_broker/classifier/decision \
  --ignore '*_test.rego' -o dist/policy-bundle.tar.gz
echo '<request-json>' | opa eval -b policy -I \
  'data.bucket_broker.classifier.decision'
```

Because evaluation is offline and the default is `escape`, an unavailable or
unclassifiable input fails closed to "escape → approval required" — never
auto-approved. No standalone OPA server is stood up.
