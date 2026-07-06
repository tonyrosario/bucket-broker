# @bucket-broker/provisioner-glue

Glue Lambda(s) for the provisioner (issue #18). Invoked by the Step Functions
`RenderAndValidate` task to:

1. **validate** the untrusted provision request against strict allowlist regexes
   (`validate.ts`);
2. **render injection-safe JSON tfvars** with `JSON.stringify` — written to
   `terraform.auto.tfvars.json` and consumed by Terraform's native JSON tfvars
   loader, so no user input is ever concatenated into HCL (`render-tfvars.ts`);
3. perform the **idempotent** `PENDING → PROVISIONING` status write, wrapped in
   the shared resilience envelope (`status.ts`, `handler.ts`).

## Reused libraries

This package reuses the platform libraries rather than reimplementing them:

- `@bucket-broker/logging` — structured JSON logs + correlation-id.
- `@bucket-broker/resilience` — timeout + circuit breaker + jittered retry
  around the DynamoDB write (ADR-0004).

There is **no root workspace or build step in CI** (each package is
self-contained per `AGENTS.md`), so the libraries are resolved directly to their
TypeScript source via `tsconfig.json` `paths` (for `tsc`/eslint) and
`jest.config.js` `moduleNameMapper` (for tests). They are therefore not listed
as npm dependencies; a live deploy bundles them with the handler.

## Scripts / gates

`npm ci` · `npm run lint` · `npm run typecheck` · `npm test` (coverage). The
injection-safety proof lives in `__tests__/render-tfvars.test.ts` (a bucket name
/ owner containing `"`, `${…}`, and newlines cannot break out of the tfvars
document or inject a new HCL variable).
