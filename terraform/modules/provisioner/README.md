# modules/provisioner

Async provisioning engine (ADR-0001). A Step Functions state machine renders
tfvars from a request, invokes a CodeBuild job that runs `terraform
init/plan/apply` against the [`golden-bucket`](../golden-bucket) module with the
S3 + DynamoDB backend from [`state-backend`](../state-backend), tracks status in
DynamoDB, dead-letters failures, bounds concurrency, and enforces the 10-minute
SLO with an execution timeout.

```
request-handler (#19)
   │ StartExecution (name = requestId)  ── writes status=PENDING
   ▼
Step Functions  ── TimeoutSeconds = 600 (10-min SLO) ──────────────┐
   ├─ RenderAndValidate (glue Lambda)                              │
   │     validate request · render JSON tfvars · set PROVISIONING  │
   ├─ RunCodeBuild (startBuild.sync)                               │
   │     assume provisioning role (BucketName/Team/RequestId tags) │
   │     terraform apply golden-bucket → per-request state key     │
   ├─ SetReady        status=READY  (cond: status=PROVISIONING)    │
   └─ on ANY error → SendToDLQ (SQS) → SetFailed (status=FAILED) → Fail
                                    │
                             DLQ-depth + ExecutionTime alarms ─────┘
```

## Two-identity runner (why the runner role is tiny)

The CodeBuild **service role** (`runner_role_arn`) holds only `logs:*` on its own
group and `sts:AssumeRole` on the provisioning role. **All** terraform work runs
under a per-request session of the **provisioning role**, assumed with validated
`BucketName` / `Team` / `RequestId` **session tags**. The provisioning role's
policy uses those tags as ABAC policy variables, so every grant resolves to the
*exact* per-request resource — there is no static account-wide grant to abuse,
and the runner cannot create a bucket without a validated, tagged session.

## Security design → acceptance criteria

| Constraint (issue #18) | Where it is met |
|---|---|
| Runner IAM scoped to operations actually performed; no excess state/lock writes | `iam.tf` `aws_iam_role_policy.provisioning` grants exactly the backend set (`s3:Get/Put/DeleteObject` on the per-request key prefix, `ListBucket` with an `s3:prefix` condition, lock `Get/Put/DeleteItem`). The runner service role has none of these. |
| Lock table encrypted with the tfstate key, not a data key | Consumed from `state-backend` (its lock table uses the state CMK). The runner is granted only `state_kms_key_arn`; the module `data` key is never given to it. |
| Per-request bucket creation scoped to the **exact** bucket name/ARN | `ProvisionBuckets` uses `arn:aws:s3:::${aws:PrincipalTag/BucketName}` (+ `-access-logs`) — the BucketName session tag resolves to one exact bucket, not a `name-*` prefix. The `provisioned_bucket_prefix` bound lives only in the trust policy to stop targeting pre-existing victim buckets. |
| KMS alias ops bound to the just-created key, not `key/*` | `ProvisionKeyAliasOnKey` conditions on `aws:ResourceTag/Name = golden-bucket-${BucketName}` (golden-bucket tags its key with that per-request Name), and the alias ARN itself is the exact `alias/golden-bucket-${BucketName}`. |
| KMS use-grants keyed by a per-request tag, never the universal `Module` tag; no `PutKeyPolicy`/`ScheduleKeyDeletion` | `UseProvisionKey` conditions on `aws:ResourceTag/Name` (unique per bucket). `kms:PutKeyPolicy` and `kms:ScheduleKeyDeletion` are never granted. |
| **Platform keys off-limits regardless of tags (#18 P0-1)** | Two explicit **Deny** statements: `DenyPlatformDataLogsKeys` (all `kms:*` on the `data`+`logs` keys, unconditional) and `DenyDirectStateKeyKMS` (all `kms:*` on the state CMK when `kms:ViaService` is absent). An explicit Deny beats the tag-based `TagProvisionKeyAtCreate`/`UseProvisionKey` Allow, so a session can neither tag-then-decrypt the data/logs keys nor gain direct `kms:Decrypt` on the state CMK. The per-request golden-bucket key (a different ARN) is unaffected. |
| State CMK grant adds `kms:ViaService` (s3+dynamodb) **and** `aws:SourceAccount` | `StateKMSViaService` — a leaked runner credential cannot Decrypt an exfiltrated state blob via the KMS API directly (#9 iac-1); `DenyDirectStateKeyKMS` (above) hardens this against the tag path. |
| **No `CreateRole` → account-admin privesc (#18 P0-2)** | `iam:CreateRole` is gated on `Condition StringEquals iam:PermissionsBoundary = <team-role boundary>` (`CreateTeamRoleWithBoundary`); the module creates that boundary (`aws_iam_policy.team_role_boundary`, wired to golden-bucket's team role), capping any created role to S3 data-plane on the platform namespace + KMS-via-S3. `iam:CreatePolicyVersion` is removed (the per-request crud policy is created fresh, never versioned), and the runner holds no `iam:PutRolePermissionsBoundary`, so neither the attached policy's content nor the boundary can be swapped. |
| Trust tags `Team`/`RequestId` constrained (#18 #4) | The provisioning-role trust policy no longer leaves `Team`/`RequestId` as bare `*`: `Team` must be non-empty and free of `/ : , space` (`StringNotLike`); `RequestId` is pinned to the 8-4-4-4-12 UUID layout the request-handler emits. |
| Pin `terraform_state_principals` to the deploying account (reject cross-account) | The module never populates `state-backend`'s grant (stays dormant). `broker_principal_arns` is format-validated and an apply-time `precondition` in `iam.tf` rejects any ARN outside the deploying account (#9 iac-3 / ADR-0001). |
| S3 object-access auditing for the state bucket | `cloudtrail.tf` — an interim CloudTrail records S3 data events for the state bucket to a hardened, KMS-encrypted audit bucket until observability (#23) wires access logging. Gate with `enable_state_bucket_audit_trail`. |
| CodeBuild source pinned to an immutable commit SHA | `codebuild_source_version` is validated as a 40-char SHA; `source_version` uses it. `terraform plan` runs data sources with the assumed role, so the ref must be immutable (#16 delivery-vector). |
| tfvars rendered without concatenating user input into HCL | The glue (`src/provisioner-glue`) serializes every value with `JSON.stringify` to `terraform.auto.tfvars.json` (Terraform's native JSON loader) after strict input validation — no HCL lexing of untrusted text. |
| Team role trusts concrete broker principals, no OIDC (ADR-0006) | `broker_principal_arns` is rendered by the glue into golden-bucket's `trusted_principals`. |

## Known limitations

- **Intra-namespace tenant isolation on destructive S3 (#18 P1).** `ProvisionBuckets`
  grants `s3:DeleteBucket`/`PutBucketPolicy`/`DeleteBucketPolicy` on
  `${aws:PrincipalTag/BucketName}` (+`-access-logs`). The `BucketName` tag resolves
  to one *exact* bucket, but nothing ties that bucket to the **requesting tenant**:
  a request whose validated `BucketName` names *another* team's existing
  `bucketbroker-*` bucket could delete it or rewrite its policy. Ownership currently
  rests on the request-handler (#19) issuing only tenant-owned names; the ABAC layer
  enforces the namespace bound, not per-tenant ownership. A durable fix (resource-tag
  ownership condition, or embedding the tenant/RequestId in the bucket name and
  scoping destructive actions to it) is tracked as a follow-up — see the linked issue
  on PR #40. This does **not** widen the P0 blast radius (it stays inside the platform
  namespace) but is a real intra-namespace integrity gap.
- **Interim audit-bucket immutability (ties into #20).** The audit bucket is versioned,
  has log-file validation, and now a bucket-policy **Deny** on `s3:DeleteObject`/
  `DeleteObjectVersion` (`DenyAuditHistoryTamper`) so history cannot be manually purged
  (Lifecycle expiration, being service-driven, still prunes noncurrent versions).
  Full immutability — S3 **Object Lock (COMPLIANCE)** — is deferred to the pending #20
  Object Lock decision and the #23 observability wiring.

## SLO / DLQ / status / concurrency

- **10-min SLO:** `aws_sfn_state_machine.definition` sets top-level
  `TimeoutSeconds = var.execution_timeout_seconds` (600). The `RunCodeBuild` task
  timeout sits below it. `slo_breach` (`AWS/States ExecutionTime`) alarms on
  breach.
- **DLQ + alert:** any error routes to `SendToDLQ` (SQS, KMS-encrypted, 14-day
  retention) then `SetFailed`; `dlq_depth` alarms on depth > 0.
- **Status lifecycle:** `PENDING` (request-handler) → `PROVISIONING` (glue,
  conditional) → `READY`/`FAILED` (state machine, each with a
  `ConditionExpression`).
- **Bounded concurrency / idempotency:** the CodeBuild project sets
  `concurrent_build_limit`; each request writes an isolated state key
  (`provisioned/<requestId>/…`) so locks never contend across requests;
  StartExecution name = requestId dedups, and every status write is conditional,
  so redrives are safe. `terraform apply` is declaratively idempotent.

## Runner root

[`runner/`](./runner) is the tiny root config CodeBuild applies: a partial
`backend "s3" {}` (filled per request via `-backend-config`) plus a single
`module "golden_bucket"` call fed by `terraform.auto.tfvars.json`.

## Inputs (selected)

| Name | Description |
|---|---|
| `prefix` | Naming prefix for all resources. |
| `state_bucket_name` / `state_bucket_arn` / `lock_table_name` / `lock_table_arn` / `state_kms_key_arn` | `state-backend` outputs. |
| `broker_principal_arns` | Concrete broker principals for the team role trust (ADR-0006). In-account only. |
| `provisioned_bucket_prefix` | Platform namespace every bucket name must start with. |
| `codebuild_source_version` | Immutable 40-char commit SHA the runner checks out. |
| `execution_timeout_seconds` | SLO ceiling (≤ 600). |
| `enable_state_bucket_audit_trail` | Toggle the interim CloudTrail (default true). |

See `variables.tf` for the full set and validation rules; `outputs.tf` for
outputs (state machine ARN, status table, project, role ARNs, DLQ, audit bucket).

## Tests & gates

`terraform fmt -check`, `init -backend=false` + `validate`, `tfsec`, `checkov`,
and `terraform test` (mock_provider) all pass. `tests/provisioner.tftest.hcl`
asserts the SLO timeout, DLQ/FAILED path, the ABAC + `kms:ViaService` scoping,
the absence of `kms:PutKeyPolicy`/`ScheduleKeyDeletion`, and the minimality of
the runner role.
