import { ResiliencePolicy } from "@bucket-broker/resilience";
import { Logger } from "@bucket-broker/logging";
import { authenticate, type AuthenticateDeps } from "../src/authenticate";
import { JwksCache, type Jwk, type JwksFetcher } from "../src/jwks";
import { AuthDenied } from "../src/errors";
import { makeKey, signJwt, validClaims, type TestKey } from "./helpers/jwt-factory";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "api://bucket-broker";

function silentLogger(): Logger {
  return new Logger({ service: "authorizer", layer: "lambda", correlationId: "test", output: () => undefined });
}

function policy(): ResiliencePolicy {
  return new ResiliencePolicy({
    dependency: "oidc-jwks",
    timeoutMs: 1000,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 10 },
    breaker: { failureThreshold: 0.5, rollingCount: 4, minimumThroughput: 2, openDurationMs: 1000, halfOpenMaxProbes: 1, successThreshold: 1 },
  });
}

function cacheFor(keys: Jwk[]): JwksCache {
  const fetcher: JwksFetcher = () => Promise.resolve(keys);
  return new JwksCache({ jwksUri: "https://idp.example.com/keys", policy: policy(), fetcher, ttlMs: 60_000, minRefreshIntervalMs: 0 });
}

function deps(key: TestKey, overrides: Partial<AuthenticateDeps> = {}): AuthenticateDeps {
  return {
    config: { issuer: ISSUER, audience: AUDIENCE },
    jwksCache: cacheFor([key.jwk]),
    logger: silentLogger(),
    nowMs: Date.now(),
    clockSkewSec: 60,
    groupsClaim: "groups",
    ...overrides,
  };
}

describe("authenticate", () => {
  it("returns an identity with subject and groups for a valid token", async () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const identity = await authenticate(token, deps(key));
    expect(identity.sub).toBe("user-123");
    expect(identity.groups).toEqual(["platform-eng", "data-team"]);
    expect(identity.issuer).toBe(ISSUER);
  });

  it("authenticates a valid token that carries NO groups (authN only — ADR-0006)", async () => {
    const key = makeKey("k1");
    const payload = validClaims(ISSUER, AUDIENCE);
    delete payload.groups;
    const token = signJwt({ key, payload });
    const identity = await authenticate(token, deps(key));
    expect(identity.groups).toEqual([]); // empty groups is NOT a denial
  });

  it("rejects a malformed token", async () => {
    const key = makeKey("k1");
    await expect(authenticate("not.a.jwt", deps(key))).rejects.toBeInstanceOf(AuthDenied);
  });

  it("rejects an unsupported alg before any key lookup", async () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE), headerAlg: "HS256" });
    await expect(authenticate(token, deps(key))).rejects.toMatchObject({ reason: "unsupported_alg" });
  });

  it("rejects a token with no kid", async () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE), kid: null });
    await expect(authenticate(token, deps(key))).rejects.toMatchObject({ reason: "missing_kid" });
  });

  it("rejects an unknown kid (no matching JWKS key)", async () => {
    const signer = makeKey("signer-kid");
    const published = makeKey("published-kid");
    const token = signJwt({ key: signer, payload: validClaims(ISSUER, AUDIENCE) });
    await expect(authenticate(token, deps(signer, { jwksCache: cacheFor([published.jwk]) }))).rejects.toMatchObject({
      reason: "unknown_kid",
    });
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const signer = makeKey("k1");
    const published = makeKey("k1"); // same kid, different material
    const token = signJwt({ key: signer, payload: validClaims(ISSUER, AUDIENCE) });
    await expect(authenticate(token, deps(signer, { jwksCache: cacheFor([published.jwk]) }))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
  });

  it("rejects a wrong issuer / audience / expired token", async () => {
    const key = makeKey("k1");
    const badIss = signJwt({ key, payload: validClaims("https://evil", AUDIENCE) });
    await expect(authenticate(badIss, deps(key))).rejects.toMatchObject({ reason: "invalid_issuer" });

    const badAud = signJwt({ key, payload: validClaims(ISSUER, "api://other") });
    await expect(authenticate(badAud, deps(key))).rejects.toMatchObject({ reason: "invalid_audience" });

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE, { exp: nowSec - 3600 }) });
    await expect(authenticate(expired, deps(key))).rejects.toMatchObject({ reason: "token_expired" });
  });

  it("rejects a token with no sub claim", async () => {
    const key = makeKey("k1");
    const payload = validClaims(ISSUER, AUDIENCE);
    delete payload.sub;
    const token = signJwt({ key, payload });
    await expect(authenticate(token, deps(key))).rejects.toMatchObject({ reason: "missing_claim" });
  });
});
