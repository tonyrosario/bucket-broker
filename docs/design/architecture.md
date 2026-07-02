# Architecture — S3 Self-Service Provisioning Platform

## Goal

A user hits a URL, authenticates via an OIDC IdP (Okta-like, config-driven — no hardcoding),
and receives a team-owned, hardened S3 bucket provisioned within a **10-minute SLO**. The
platform enforces a **golden path** (opinionated safe defaults) with **audited escape paths**
for overrides. Security is built in from the ground up, with a separate hardening/pen-test
phase. Errors are logged across every layer and platform metrics are collected.

Core decisions are recorded as ADRs: [0001](../adr/0001-aws-native-terraform-runner.md)
(runner), [0002](../adr/0002-rest-api-thin-web-form.md) (interface),
[0003](../adr/0003-audited-escape-paths.md) (escape paths),
[0004](../adr/0004-third-party-resilience.md) (third-party outage resilience).

## Request flow

```
  User ── clicks link ──▶ Static web form (S3 + CloudFront)
                          → Okta OIDC login (PKCE) → JWT (group claim)
                                          │ POST /buckets  (Bearer JWT)
                                          ▼
                          API Gateway (REST) + WAF + throttling
                          JWT authorizer → validate vs Okta JWKS     ← issuer/aud from SSM
                                          ▼
                          request-handler Lambda
                            1. identity + groups from JWT
                            2. authz: group→entitlements (DynamoDB)   ← no hardcoding
                            3. OPA classify: golden vs escape
                            4. write request (DynamoDB, status=PENDING)
                            5. metrics + structured log (correlation-id)
                    golden ▼                         escape ▼
          Step Functions                   Approval flow
            render tfvars        ◀── appr ──  status=AWAITING_APPROVAL
            → CodeBuild                        SNS notify approvers
              terraform apply                  justification logged (audit)
            → DynamoDB status                  approver decision → enqueue
            → metrics / EventBridge
            timeout guard ≤ 10 min
                      ▼
          Golden-path S3 bucket
            SSE-KMS · Block Public Access · versioning · TLS-only policy
            access logging · lifecycle · tags(team,owner,cost-center,path)
            team-scoped CRUD via IAM role (= IdP group)

  Cross-cutting: CloudWatch structured logs + metric filters + alarms · X-Ray tracing ·
  correlation-id through every layer · DLQs on async steps · immutable escape-audit log.
```

### Golden happy path
1. User opens the link → static form → Okta OIDC (PKCE) → JWT with `groups` claim.
2. `POST /buckets` with Bearer JWT → API Gateway JWT authorizer validates against Okta JWKS
   (issuer / audience / JWKS URI read from SSM, making the IdP swappable).
3. `request-handler` resolves identity + groups, looks up entitlements, validates the body
   against the golden schema.
4. OPA classifier deterministically labels the request golden or escape.
5. Golden → Step Functions execution starts; record `status=PENDING`; metric emitted.
6. Step Functions renders tfvars → CodeBuild runs `terraform init/plan/apply` on the
   `golden-bucket` module (state in S3 + DynamoDB lock) → `status=PROVISIONING→READY`.
7. `GET /buckets/{id}` returns status; SLO alarm fires if execution > 10 min.

## Authorization model (no hardcoding, IdP-flexible)

- **Team = IdP group.** Buckets are owned by a team; a single-user bucket is the edge case
  (a group of one).
- An `entitlements` DynamoDB table maps **group → {can_create, teams[], access{read,write,delete}}**.
  This is data, not code — swapping Okta for any OIDC IdP means changing issuer/JWKS config
  and populating the mapping table.
- Bucket access is granted to a **team IAM role** whose trust maps back to the IdP group; the
  bucket policy references that role. CRUD is expressed as IAM actions scoped to the bucket.

## Terraform module layout (fan-out-friendly)

Boundaries are drawn so parallel worktree agents don't collide on merge.

| Module | Responsibility | Coupling |
|--------|----------------|----------|
| `modules/state-backend` | S3 state bucket + DynamoDB lock (KMS) | Standalone (runs first) |
| `modules/golden-bucket` | Paved-road bucket: SSE-KMS, BPA, versioning, TLS-only policy, access logging, lifecycle, tags, team IAM | Standalone, pure |
| `modules/identity` | OIDC config (SSM), `entitlements` table, group→role mapping | Standalone |
| `modules/platform-api` | API GW + WAF, JWT authorizer, request-handler Lambda, request table | Depends on identity |
| `modules/provisioner` | Step Functions, CodeBuild, tfvars rendering, status table, DLQs | Depends on golden-bucket + state-backend |
| `modules/approval` | Escape approval flow: SNS, approval table, immutable audit log (S3 Object Lock) | Depends on platform-api |
| `modules/policy` | OPA/Rego golden-vs-escape classifier + guardrails | Standalone, pure |
| `modules/observability` | CloudWatch dashboards, alarms, metric filters, X-Ray, log groups | Consumes others' outputs |
| `envs/{dev,stage,prod}` | Env composition + backend config | Top-level wiring |

App code: `src/authorizer/`, `src/request-handler/`, `src/provisioner-glue/`, `src/approval/`,
`web/` (static form). Each maps to one module → one issue.

## Cross-cutting requirements

- **Security from the ground up:** least-privilege IAM per Lambda/CodeBuild; KMS on state,
  buckets, logs, DynamoDB; BPA enforced + guardrail denying public unless escape-approved;
  API GW WAF + throttling + input validation; OIDC client secret in Secrets Manager;
  encrypted + locked TF state. A **separate hardening/pen-test milestone** runs
  tfsec/checkov/Prowler, IAM Access Analyzer, a threat-model review, and a pen-test pass.
- **Error logging across layers:** structured JSON logs from web → API → authorizer →
  handler → Step Functions → CodeBuild, all carrying a propagated **correlation-id**; X-Ray
  end-to-end; metric filters on error patterns → alarms; DLQs on async steps.
- **Metrics:** provisioning latency p50/p95/p99 vs the 10-min SLO, success/failure counts,
  **escape-path usage rate**, approval queue depth + latency, per-team bucket counts,
  auth-failure rate. CloudWatch dashboards + alarms; EventBridge for downstream sinks.
- **10-min SLO:** async orchestration; single-bucket apply ~1–3 min; Step Functions timeout
  + CloudWatch alarm enforce the budget; `GET /buckets/{id}` for status polling. The SLO
  covers provisioning, not escape-path approval wait (see ADR-0003).
- **Cost:** serverless / pay-per-use; idle ≈ $0; a few dollars/month at demo volume.
- **Third-party outage resilience (ADR-0004):** every external call (OIDC JWKS, notifiers,
  remote OPA if used) is wrapped in a timeout + **circuit breaker** + retry-with-jitter, with
  bulkhead isolation and idempotency keys. Fallbacks are dependency-specific: JWKS keys are
  cached with stale-while-revalidate so valid tokens keep working during an IdP outage (auth
  **fails closed** on unverifiable tokens); approval records are persisted before the
  best-effort notification (queued/DLQ'd on failure) so escapes are never dropped; OPA is
  preferably in-process (no network hop) and, if remote, its breaker fallback fails closed to
  "escape → approval required". Breaker state and fallback activations are logged + emitted as
  metrics. A shared resilience helper is reused across all Lambdas.

## Decomposition (→ tracer-bullet vertical slices)

Each slice is independently grabbable with minimal shared files, so worktree agents run in
parallel with low merge conflict.

1. `state-backend` bootstrap module.
2. `golden-bucket` module + tests.
3. `identity` (OIDC config + entitlements table).
4. JWT authorizer (Lambda).
5. `request-handler` Lambda + API GW + WAF.
6. `policy` OPA golden/escape classifier + tests.
7. `provisioner` (Step Functions + CodeBuild + status).
8. `approval` escape flow + immutable audit log.
9. `observability` (dashboards/alarms/metrics).
10. Error-logging / correlation-id cross-cut.
11. `web/` static form + OIDC login.
12. CI/CD + tfsec/checkov/Prowler gates.
13. `envs/{dev,stage,prod}` composition.
14. Hardening & pen-test milestone (checklist, findings, remediation).
15. Shared resilience helper (timeout + circuit breaker + jittered retry) + JWKS cache with
    stale-serve + idempotency-key store + notification retry/DLQ (ADR-0004), with
    outage-injection tests.

## Verification (end-to-end)

- **Unit/policy:** OPA `opa test` for classification; Terraform `validate` + tfsec/checkov;
  Lambda handler unit tests.
- **Integration (dev):** deploy `envs/dev`; drive `POST /buckets` with a mock-OIDC JWT for a
  golden request → assert bucket exists with SSE-KMS + BPA + versioning + correct tags/team
  IAM within 10 min.
- **Escape flow:** submit an override (e.g. public access) → assert `AWAITING_APPROVAL`, SNS
  notification, audit-log entry; approve → assert provisioning + escape metric increment.
- **Negative:** unentitled group → 403; malformed request → 400; expired/invalid JWT → 401.
- **SLO/observability:** confirm latency metric, SLO alarm wiring, correlation-id across all
  log groups, X-Ray trace spanning the full path.
- **Security:** run Prowler + IAM Access Analyzer against dev; confirm no public buckets
  exist outside an approved escape.
- **Resilience (ADR-0004):** outage-injection — simulate IdP/JWKS unreachable and assert a
  valid cached token still authorizes while an unverifiable token gets 401 (fail-closed);
  simulate notifier failure and assert the escape record persists and is reconciled; assert a
  retried provision is idempotent (no duplicate bucket) and the circuit breaker opens/half-
  opens/closes as expected.
