import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayRequestAuthorizerEvent, Context } from "aws-lambda";
import { handler, __resetForTests, __setFetcherForTests } from "../src/index";
import type { Jwk } from "../src/jwks";
import { makeKey, signJwt, validClaims, type TestKey } from "./helpers/jwt-factory";

const ssmMock = mockClient(SSMClient);

const ISSUER = "https://idp.example.com";
const AUDIENCE = "api://bucket-broker";
const JWKS_URI = "https://idp.example.com/keys";
const METHOD_ARN = "arn:aws:execute-api:us-east-1:123456789012:abcdef/prod/POST/buckets";

function seedSsm(): void {
  ssmMock.on(GetParametersCommand).resolves({
    Parameters: [
      { Name: "/bucket-broker/oidc/issuer", Value: ISSUER },
      { Name: "/bucket-broker/oidc/audience", Value: AUDIENCE },
      { Name: "/bucket-broker/oidc/jwks-uri", Value: JWKS_URI },
    ],
  });
}

function makeEvent(headers: Record<string, string | undefined>): APIGatewayRequestAuthorizerEvent {
  return {
    type: "REQUEST",
    methodArn: METHOD_ARN,
    resource: "/buckets",
    path: "/buckets",
    httpMethod: "POST",
    headers,
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayRequestAuthorizerEvent["requestContext"],
  } as APIGatewayRequestAuthorizerEvent;
}

const ctx = { awsRequestId: "req-abc" } as Context;

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("handler (REQUEST authorizer)", () => {
  beforeEach(() => {
    ssmMock.reset();
    __resetForTests();
    process.env.SSM_OIDC_ISSUER_NAME = "/bucket-broker/oidc/issuer";
    process.env.SSM_OIDC_AUDIENCE_NAME = "/bucket-broker/oidc/audience";
    process.env.SSM_OIDC_JWKS_URI_NAME = "/bucket-broker/oidc/jwks-uri";
    process.env.JWKS_CACHE_TTL_MS = "0"; // always stale → exercise refresh path
    process.env.JWKS_MIN_REFRESH_INTERVAL_MS = "0"; // no throttle in tests
    // Keep the breaker closed across cases (window far larger than the handful
    // of calls each test makes) so outcomes don't depend on breaker state.
    process.env.JWKS_BREAKER_ROLLING_COUNT = "1000";
    process.env.JWKS_BREAKER_MIN_THROUGHPUT = "1000";
    seedSsm();
  });

  it("allows a valid token and forwards sub + groups in the authorizer context", async () => {
    const key = makeKey("k1");
    __setFetcherForTests(() => Promise.resolve([key.jwk]));
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });

    const result = await handler(makeEvent(bearer(token)), ctx);

    expect(result.principalId).toBe("user-123");
    expect(result.policyDocument.Statement[0]).toMatchObject({
      Effect: "Allow",
      Action: "execute-api:Invoke",
      Resource: METHOD_ARN,
    });
    expect(result.context?.sub).toBe("user-123");
    expect(JSON.parse(String(result.context?.groups))).toEqual(["platform-eng", "data-team"]);
    expect(result.context?.issuer).toBe(ISSUER);
    expect(result.context?.correlationId).toBeDefined();
  });

  it("propagates an incoming correlation-id into the context", async () => {
    const key = makeKey("k1");
    __setFetcherForTests(() => Promise.resolve([key.jwk]));
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });

    const headers = { ...bearer(token), "x-correlation-id": "corr-123" };
    const result = await handler(makeEvent(headers), ctx);
    expect(result.context?.correlationId).toBe("corr-123");
  });

  it("fails closed (throws Unauthorized) when the Authorization header is absent", async () => {
    __setFetcherForTests(() => Promise.resolve([]));
    await expect(handler(makeEvent({}), ctx)).rejects.toThrow("Unauthorized");
  });

  it("fails closed for a malformed token", async () => {
    const key = makeKey("k1");
    __setFetcherForTests(() => Promise.resolve([key.jwk]));
    await expect(handler(makeEvent(bearer("garbage.token")), ctx)).rejects.toThrow("Unauthorized");
  });

  it("fails closed for an expired token", async () => {
    const key = makeKey("k1");
    __setFetcherForTests(() => Promise.resolve([key.jwk]));
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE, { exp: nowSec - 3600 }) });
    await expect(handler(makeEvent(bearer(token)), ctx)).rejects.toThrow("Unauthorized");
  });

  // ── Outage simulation end-to-end (issue #17 acceptance criterion) ─────────
  describe("JWKS outage simulation", () => {
    let key: TestKey;
    let calls: number;

    beforeEach(() => {
      key = makeKey("known-kid");
      calls = 0;
      // Healthy on the first fetch, unreachable forever after.
      const fetcher = (): Promise<Jwk[]> => {
        calls += 1;
        return calls === 1 ? Promise.resolve([key.jwk]) : Promise.reject(new Error("ECONNREFUSED"));
      };
      __setFetcherForTests(fetcher);
    });

    it("keeps validating a known token from the stale cache while the IdP is down", async () => {
      const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });

      // Warm the cache (healthy fetch).
      await handler(makeEvent(bearer(token)), ctx);

      // IdP now unreachable; the same valid token must still be allowed.
      const result = await handler(makeEvent(bearer(token)), ctx);
      expect(result.policyDocument.Statement[0].Effect).toBe("Allow");
      expect(calls).toBeGreaterThanOrEqual(2); // a refresh WAS attempted and failed
    });

    it("denies an unknown-kid token during the outage (fail closed → 401)", async () => {
      const known = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
      await handler(makeEvent(bearer(known)), ctx); // warm cache

      const attackerKey = makeKey("attacker-kid");
      const attackerToken = signJwt({ key: attackerKey, payload: validClaims(ISSUER, AUDIENCE) });
      await expect(handler(makeEvent(bearer(attackerToken)), ctx)).rejects.toThrow("Unauthorized");
    });
  });
});
