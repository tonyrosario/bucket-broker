# Agent Instructions

This repository uses GitHub as the source of truth for roadmap and delivery work.

## Before Starting

An issue is grabbable only if **all** of the following hold:

- It is labeled `agent-ready` and is **not** labeled `blocked`.
- Every issue listed in its "Blocked by" section is closed **via a merged PR**
  (a closed-without-merge blocker still blocks).
- It has no assignee, no `in-progress` label, and no unresolved claim comment.

If any check fails, do not implement it.

Read:

- The assigned issue
- Linked parent issues
- Relevant repository docs — start with `docs/design/architecture.md`, the ADRs
  in `docs/adr/`, and `docs/ci.md`
- Existing code near the change

## Claiming an Issue

Before writing any code:

1. Assign yourself to the issue (or comment `claiming` if assignment is unavailable).
2. Replace the `agent-ready` label with `in-progress`.

An existing assignee, claim comment, or `in-progress` label is a hard hands-off.
One agent per issue. When your PR opens, add the `needs-review` label to the issue.

## Branches and Worktrees

- One issue = one branch = one worktree. Never share a worktree between issues.
- Branch from `main`, named `feat/<issue#>-<short-slug>` (e.g. `feat/9-state-backend`).
- Build state is per-worktree: never share or copy `.terraform/` or `node_modules/`
  between worktrees.
- Rebase on `main` before opening the PR, and again whenever a PR your issue was
  blocked by merges.

## Shared Files

Root tooling files are owned by specific issues, not by whoever needs them first.
Do not create or modify any of the following unless your issue explicitly grants it:

- Root `package.json`, lockfiles, base `tsconfig`, lint/format/test config
- `.github/workflows/*`
- `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, issue/PR templates

If your slice needs something missing from these files, stop and comment a blocker
on your issue instead of editing them.

ADR filenames race under parallel work: before adding an ADR, claim the next free
number in a comment on your issue, and re-check for collisions when you rebase.

## Rules

You may:

- Create a branch
- Make scoped changes
- Commit changes
- Open a pull request
- Request human review
- Comment with blockers

You may not:

- Merge pull requests
- Enable auto-merge
- Push directly to protected branches or bypass branch protection
- Edit rulesets, branch protection, or repository settings
- Change roadmap priorities
- Work on issues not marked `agent-ready`
- Introduce dependencies unless explicitly allowed by the issue
- Touch secrets, auth, billing, production deploy config, permissions, or
  infrastructure unless explicitly allowed by the issue
- Expand scope beyond the issue

## Workflow

1. Restate the task in your own working notes.
2. Inspect the repository before editing.
3. Make the smallest useful change.
4. Run the verification gates below.
5. Open a PR linked to the issue.
6. Include verification and limitations in the PR body.

## Verification

Run the same gates CI runs (see `docs/ci.md` for pinned versions and details) in
your worktree before opening a PR. A PR is not ready until every gate that applies
to your change passes locally:

- `terraform fmt -check -recursive`; `terraform init -backend=false` + `terraform validate`
  per module/root
- `tfsec` and `checkov` over all `*.tf`
- `opa fmt --fail` and `opa test` over all `*.rego`
- `npm run lint`, `npm run typecheck`, `npm test` wherever `package.json` exists
- No secrets in the diff (gitleaks runs in CI over the full history)

## If Blocked

Stop and comment on the issue with:

- Why you are blocked
- What you tried
- What you need from a human

## Pull Requests

Every PR must include:

- Linked issue
- Summary
- Verification
- Known limitations
- Confirmation that forbidden areas were not touched unless explicitly allowed

Humans merge. Agents do not merge.

The enforced merge gate on `main` is the active ruleset: a pull request is required
and the five required status checks must pass (`Secret scan (gitleaks)`,
`Terraform fmt + validate`, `Terraform security (tfsec + checkov)`,
`OPA policy tests`, `Node lint + typecheck + test`). Required approvals are 0
because a solo repository cannot require self-approval — human review is enforced
by policy, not by the ruleset. Concretely: never run `gh pr merge`, never enable
auto-merge, never edit rulesets or branch protection. If the ruleset on `main` is
missing or its required checks are disabled, stop and report a blocker instead of
proceeding to merge.
