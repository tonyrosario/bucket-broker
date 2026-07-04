# CI/CD & security gates

The PR gate lives in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It runs on every
pull request (and on pushes to `main`) and is designed so each job **always reports a status** —
so any of them can be made a *required check* — while cleanly no-op'ing on layers that don't exist
yet. As Terraform, Rego, and Node code land, the matching jobs start enforcing automatically.

## Jobs

| Job | What it does | Blocks the PR when |
|-----|--------------|--------------------|
| **Secret scan (gitleaks)** | Scans the working tree + full history for secrets | Any secret detected |
| **Terraform fmt + validate** | `terraform fmt -check -recursive`; `init -backend=false` + `validate` for every module/root | Unformatted or invalid HCL |
| **Terraform security (tfsec + checkov)** | Static security analysis over all `*.tf` | Any tfsec/checkov finding (`--soft-fail=false`) |
| **OPA policy tests** | `opa fmt --fail` + `opa test` over all `*.rego` | Unformatted Rego or a failing policy test |
| **Node lint + typecheck + test** | `npm ci` then `lint`/`typecheck`/`test` (if present) when `package.json` exists | Lint, type, or test failure |

All third-party tooling is version-pinned (see the `env:` block in `ci.yml`) and every GitHub Action
is pinned to a full commit SHA. Scanner binaries installed via `curl` (gitleaks, tfsec, opa) are
**SHA256 checksum-verified** against the projects' published release checksums before use.

## Making the checks required (branch protection)

The gate only *gates* because the checks are required on `main`. This is a **human-owned**
governance layer (per `AGENTS.md`: agents must not set, edit, or bypass rulesets or branch
protection). The active ruleset on `main` (`main-protection`):

- Requires a pull request before merging
- Requires these status checks to pass: `Secret scan (gitleaks)`, `Terraform fmt + validate`,
  `Terraform security (tfsec + checkov)`, `OPA policy tests`, `Node lint + typecheck + test`
- Blocks direct pushes, force-pushes, and branch deletion
- Has no bypass actors

Required approvals are intentionally **0**: GitHub does not let a PR author approve their own
PR, so a solo repository would deadlock at ≥1. Human review is therefore enforced by policy —
agents never run `gh pr merge`, never enable auto-merge, and never edit rulesets (see
`AGENTS.md`) — rather than by the ruleset. If collaborators are ever added, raise
`required_approving_review_count` to ≥1 and enable "require review from someone other than
the last pusher".

## Deployed-environment scanning (Prowler) — dormant until a live account exists

[`prowler.yml`](../.github/workflows/prowler.yml) is a manual (`workflow_dispatch`) posture scan of a
deployed environment. bucket-broker is **build/plan-only** today (no live AWS account), so the
workflow guards on the repo variable `AWS_DEPLOY_ROLE_ARN` and exits with guidance until one is set.

It authenticates with **short-lived GitHub OIDC credentials — no long-lived AWS keys in CI**, and the
`severity` dispatch input is passed via an environment variable (never interpolated into the shell)
to prevent script injection. Prowler itself is version-pinned. To activate it once an account exists:

1. Provision the GitHub OIDC provider + a least-privilege deploy role (blueprint below).
2. Create a `dev` GitHub Environment with required reviewers. The prowler job binds to it
   (`environment: dev`) so the OIDC token's `sub` claim is
   `repo:tonyrosario/bucket-broker:environment:dev`, matching the trust policy below.
3. Set repo variables `AWS_DEPLOY_ROLE_ARN` (and optionally `AWS_REGION`).
4. Run the workflow from the Actions tab.

### OIDC deploy-role blueprint

Provision this as real Terraform when a live account is wired (tracked alongside the live-deploy
follow-up, #25). It is intentionally *not* committed as applied `.tf` yet — the permissions must be
tightened per-module during the hardening milestone (#24) rather than shipped as a wildcard.

```hcl
# Trust: only this repo's workflows, via GitHub OIDC, may assume the role.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # Scope tightly: a specific environment/branch, not repo:org/repo:*
      values   = ["repo:tonyrosario/bucket-broker:environment:dev"]
    }
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"] # AWS validates GitHub's CA; kept for older providers
}

resource "aws_iam_role" "deploy" {
  name                 = "bucket-broker-ci-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  # Attach a per-module, resource-scoped, tag-conditioned permissions policy —
  # NOT a wildcard. Tighten during #24 (hardening).
}
```

## Tool versions

Pinned in `ci.yml`: terraform `1.9.8`, tfsec `1.28.14`, checkov `3.3.6`, opa `1.18.2`,
gitleaks `8.30.1`, Node `20`. Pinned in `prowler.yml`: prowler `5.32.0`.
