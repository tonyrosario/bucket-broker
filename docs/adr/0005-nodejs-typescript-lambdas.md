# ADR-0005 — Node.js 20 / TypeScript as platform Lambda runtime

**Status:** Accepted 2026-07-04
**TL;DR:** All platform Lambdas (request handler, JWT authorizer, provisioner glue, approval) use Node.js 20 with TypeScript; rationale is AWS SDK v3 ergonomics and sharing one language with the web form.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

The platform requires Lambda functions for the request handler, JWT authorizer, provisioner glue
code, and approval flow. The walking skeleton (#16) is the first Lambda authored, and the runtime
choice propagates to every subsequent Lambda issue (#17, #18, #19, #20). A single runtime reduces
cognitive overhead, enables shared type definitions, and simplifies tooling.

The main contenders are Node.js (JavaScript/TypeScript), Python, and Go. The platform has a
planned React-based web form (`web/`), so a shared language lets type definitions cross the
boundary between the API contract and the browser client. The AWS SDK for JavaScript v3 is the
most actively maintained SDK, with first-class support for tree-shaking and modular imports.
TypeScript adds compile-time safety at negligible runtime cost.

## Decision

All platform Lambdas use **Node.js 20 (LTS)** with **TypeScript**. Code lives under `src/` with
a per-module `package.json` and `tsconfig.json`. Tests run with Jest + ts-jest. Linting via ESLint
with the TypeScript ESLint plugin. The `npm run lint`, `npm run typecheck`, and `npm test` scripts
are required in every Lambda module and are enforced by CI.

## Alternatives considered

- **Python 3.12:** Excellent AWS tooling (boto3), common in infrastructure-adjacent work, strong
  typing story via mypy. Rejected because it introduces a second language alongside the TypeScript
  web form, and type-sharing between API and client would require a separate code-generation step.
- **Go 1.22:** Best cold-start performance and smallest binary size; strong concurrency model.
  Rejected for a greenfield build: Go verbosity slows iteration speed, team familiarity is lower,
  and cold-start differences are negligible at this traffic volume.
- **Python + TypeScript split (by concern):** Python for infrastructure-glue Lambdas, TypeScript
  for API Lambdas. Rejected: split toolchains double the lint/test CI surface and complicate
  shared type definitions.

## Consequences

- (+) One language across web form + all Lambdas: shared types, one lint/test stack, single CI
  job template.
- (+) AWS SDK v3 for JavaScript has modular, tree-shakeable packages; bundle sizes stay small and
  cold starts remain within budget.
- (+) TypeScript strict mode catches DynamoDB marshalling errors and API contract mismatches at
  compile time.
- (-) Node.js cold-start is warmer than Go but not as fast; at demo/low-traffic volumes this is
  acceptable and within the 10-minute SLO by a wide margin.
- (-) Lambda bundle must be compiled (`tsc`) before deploy; each module needs a build step in CI.
- New work: each Lambda module needs its own `package.json`, `tsconfig.json`, and test suite. A
  shared utility package (ADR-0004 resilience helper) should be extracted once built in #21.
