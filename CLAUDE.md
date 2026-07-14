# Claude Code Instructions

Use `AGENTS.md` as the source of truth for agent instructions.

Do not duplicate policy here. Update `AGENTS.md` instead.

## Claude-specific operational notes

Conventions for Claude Code layered on top of `AGENTS.md` — tooling guidance, not policy.

### Pre-PR review

Before opening a PR, run the reviewer agents that match the diff, then
`review-validator` to judge findings against the ADRs in `docs/adr/`:

- Terraform / IAM / KMS / S3 changes → `aws-iac-reviewer` (project agent, `.claude/agents/`)
- `.github/workflows/**` changes → `gha-security-reviewer`
- Auth, secrets, or data-handling code → `security-reviewer`

### Model tiering (per subagent-token-discipline)

- Mechanical Terraform modules with well-specified acceptance criteria
  (e.g. state-backend, golden-bucket, observability wiring) → **sonnet**
- Fail-closed auth/policy/resilience logic where wrong reasoning silently
  corrupts security posture (JWT authorizer, OPA classifier, circuit breaker,
  approval/audit flow) → **opus**
- File discovery, log scraping, issue triage → **haiku**

### Fan-out

One worktree per issue (`AGENTS.md` has the claiming and shared-file rules).
Wave order: tracer bullet (#16) runs solo first; wave 1 (#9–#14) fans out in
parallel; wave 2 (#17–#19) is released only as its blockers merge.

### Local overrides

`.claude/settings.local.json` is a machine-local, gitignored override — never
commit it. Do not use it to re-allow a denied command: deny always wins over
allow in Claude Code regardless of which settings file the rule is in, so a
re-grant (this repo's local file re-allows `gh api`) is both inert and
misleading policy.
