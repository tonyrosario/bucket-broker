# ADR-0002 — REST API + thin web form as the entry point

**Status:** Accepted 2026-07-02
**TL;DR:** The product is an API Gateway REST API; a minimal static web form behind Okta OIDC is the clickable "link" that calls it.
**Author:** @tonyrosario
**Sponsoring Lead:** @tonyrosario

## Context

The requirement states that clients "hit a URL (could be a link)" and mandates an API
gateway. In practice there are two kinds of caller: humans who want to click a link and
fill in a form, and automation or CLIs that want a programmatic contract. Both must be
authenticated through the same OIDC identity provider.

## Decision

The API Gateway REST API is the durable contract, specified with OpenAPI. A minimal static
single-page form, hosted on S3 behind CloudFront, performs the Okta OIDC (PKCE) login and
then calls the API with the resulting JWT. The same API is directly usable by CLIs and
automation, so the form is a thin client rather than a privileged path.

## Alternatives considered

- **REST API only:** Simplest and most platform-native, but provides no click-through UX
  for the "link" the requirement calls for. Rejected — a static form is cheap and satisfies
  the literal ask without becoming a heavyweight application.
- **Backstage-style internal developer portal:** A software template that provisions the
  bucket. This is the fullest expression of the "paved road" idea, but is disproportionate
  scope for a greenfield build. Rejected for now; because the API is the contract, a
  Backstage plugin can be layered on later without rework.

## Consequences

- (+) One contract serves both humans and machines; the frontend surface stays small; the
  API remains the stable, testable boundary.
- (−) There are two clients (form + programmatic) to keep in sync with the OpenAPI spec.
- (−) The frontend needs its own hardening: OIDC PKCE flow, hosting, and a strict Content
  Security Policy.

## Open questions

None.
