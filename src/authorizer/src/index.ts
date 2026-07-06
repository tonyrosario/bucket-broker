/**
 * API Gateway REQUEST authorizer Lambda — validate JWT vs cached JWKS,
 * fail-closed (issue #17).
 *
 * Responsibilities (authN only — ADR-0006):
 *   1. Adopt/propagate a correlation-id and structured logging (@bucket-broker/logging).
 *   2. Load OIDC config (issuer/audience/JWKS URI) from SSM at cold start —
 *      nothing about the IdP is hardcoded.
 *   3. Validate the bearer JWT's signature + issuer + audience + exp/nbf against
 *      JWKS keys cached with TTL + stale-while-revalidate behind the shared
 *      resilience helper (@bucket-broker/resilience: timeout + breaker + retry).
 *   4. On success, Allow and forward the caller's subject + group claims in the
 *      authorizer context for the request-handler (#19) to authorize against the
 *      entitlements table. The authorizer NEVER allows/denies on group membership.
 *   5. On any validation doubt, fail closed → 401 with a structured log.
 *
 * Module-scope singletons (registry, cached config, cache) survive warm
 * invocations, so the circuit-breaker state and cached JWKS persist between
 * requests exactly as ADR-0004 intends.
 */

import { SSMClient } from "@aws-sdk/client-ssm";
import { ResilienceRegistry } from "@bucket-broker/resilience";
import type { ResiliencePolicy } from "@bucket-broker/resilience";
import { Logger, adoptOrGenerate } from "@bucket-broker/logging";
import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
  Context,
} from "aws-lambda";

import { authenticate, type Identity } from "./authenticate";
import { loadOidcConfig, type OidcConfig, type OidcParamNames } from "./config";
import { AuthDenied } from "./errors";
import { JwksCache, httpsJwksFetcher, type JwksFetcher } from "./jwks";

const SERVICE = "authorizer";
const LAYER = "lambda";
const JWKS_DEPENDENCY = "oidc-jwks";

// ── Cold-start singletons ──────────────────────────────────────────────────
const ssmClient = new SSMClient({});
const registry = new ResilienceRegistry();
let bootstrapPromise: Promise<Bootstrap> | null = null;
let fetcherOverride: JwksFetcher | null = null;

interface Bootstrap {
  config: OidcConfig;
  jwksCache: JwksCache;
}

// ── Small env helpers ──────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new AuthDenied("config_error", `Missing required env var ${name}`);
  }
  return v;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build (once) the resilience policy for the JWKS dependency. Registered on the
 * shared registry so the SAME breaker is reused across warm invocations.
 */
function jwksPolicy(): ResiliencePolicy {
  return registry.getOrRegister({
    dependency: JWKS_DEPENDENCY,
    timeoutMs: numEnv("JWKS_TIMEOUT_MS", 2000),
    retry: {
      maxAttempts: numEnv("JWKS_RETRY_MAX_ATTEMPTS", 3),
      baseDelayMs: numEnv("JWKS_RETRY_BASE_DELAY_MS", 100),
      maxDelayMs: numEnv("JWKS_RETRY_MAX_DELAY_MS", 1000),
      totalBudgetMs: numEnv("JWKS_RETRY_TOTAL_BUDGET_MS", 3000),
    },
    breaker: {
      failureThreshold: numEnv("JWKS_BREAKER_FAILURE_THRESHOLD", 0.5),
      rollingCount: numEnv("JWKS_BREAKER_ROLLING_COUNT", 10),
      minimumThroughput: numEnv("JWKS_BREAKER_MIN_THROUGHPUT", 3),
      openDurationMs: numEnv("JWKS_BREAKER_OPEN_DURATION_MS", 30_000),
      halfOpenMaxProbes: numEnv("JWKS_BREAKER_HALF_OPEN_PROBES", 1),
      successThreshold: numEnv("JWKS_BREAKER_SUCCESS_THRESHOLD", 2),
    },
  });
}

/**
 * Cold-start bootstrap: read OIDC config from SSM and build the JWKS cache.
 * Cached as a promise so concurrent cold invocations share one SSM read; a
 * failed bootstrap is NOT cached, so the next request retries.
 */
function bootstrap(): Promise<Bootstrap> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async (): Promise<Bootstrap> => {
      const names: OidcParamNames = {
        issuer: requireEnv("SSM_OIDC_ISSUER_NAME"),
        audience: requireEnv("SSM_OIDC_AUDIENCE_NAME"),
        jwksUri: requireEnv("SSM_OIDC_JWKS_URI_NAME"),
      };
      const config = await loadOidcConfig(ssmClient, names);
      const jwksCache = new JwksCache({
        jwksUri: config.jwksUri,
        policy: jwksPolicy(),
        fetcher: fetcherOverride ?? httpsJwksFetcher,
        ttlMs: numEnv("JWKS_CACHE_TTL_MS", 600_000),
        minRefreshIntervalMs: numEnv("JWKS_MIN_REFRESH_INTERVAL_MS", 30_000),
      });
      return { config, jwksCache };
    })().catch((err) => {
      bootstrapPromise = null;
      throw err;
    });
  }
  return bootstrapPromise;
}

/** Test-only: reset cold-start singletons between cases. */
export function __resetForTests(): void {
  bootstrapPromise = null;
  fetcherOverride = null;
}

/** Test-only: inject a JWKS fetcher so handler tests make no real network call. */
export function __setFetcherForTests(fetcher: JwksFetcher): void {
  fetcherOverride = fetcher;
}

/** Extract the raw JWT from the `Authorization: Bearer <jwt>` header. */
function extractBearerToken(event: APIGatewayRequestAuthorizerEvent): string {
  const headers = event.headers ?? {};
  let authHeader: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      authHeader = value ?? undefined;
      break;
    }
  }
  if (!authHeader) {
    throw new AuthDenied("missing_token", "No Authorization header");
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match || !match[1]) {
    throw new AuthDenied("missing_token", "Authorization header is not a Bearer token");
  }
  return match[1].trim();
}

/**
 * Build an Allow policy scoped to the invoked method, forwarding identity +
 * groups in the authorizer context. Context values must be primitives, so the
 * groups array is JSON-encoded for the request-handler to parse. The Allow is
 * based ONLY on token validity — never on group membership (ADR-0006).
 */
function allowPolicy(
  identity: Identity,
  event: APIGatewayRequestAuthorizerEvent,
  correlationId: string,
): APIGatewayAuthorizerResult {
  return {
    principalId: identity.sub,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          Resource: event.methodArn,
        },
      ],
    },
    context: {
      sub: identity.sub,
      groups: JSON.stringify(identity.groups),
      issuer: identity.issuer,
      correlationId,
    },
  };
}

/**
 * Lambda entry point. Returns an Allow policy for a valid token; throws
 * `Unauthorized` (which API Gateway maps to HTTP 401) for every failure — the
 * single fail-closed exit. A structured log is emitted before every denial.
 */
export async function handler(
  event: APIGatewayRequestAuthorizerEvent,
  context: Context,
): Promise<APIGatewayAuthorizerResult> {
  const correlationId = adoptOrGenerate({
    headers: event.headers ?? undefined,
    awsRequestId: context.awsRequestId,
  });
  const logger = new Logger({ service: SERVICE, layer: LAYER, correlationId });
  logger.annotateTrace();

  try {
    const token = extractBearerToken(event);
    const { config, jwksCache } = await bootstrap();

    const identity = await authenticate(token, {
      config,
      jwksCache,
      logger,
      nowMs: Date.now(),
      clockSkewSec: numEnv("CLOCK_SKEW_SEC", 60),
      groupsClaim: process.env["GROUPS_CLAIM"] ?? "groups",
    });

    logger.info("Token validated; allowing request", {
      sub: identity.sub,
      groupCount: identity.groups.length,
      methodArn: event.methodArn,
    });
    return allowPolicy(identity, event, correlationId);
  } catch (err) {
    if (err instanceof AuthDenied) {
      // Expected fail-closed path: log the reason (never the token) and 401.
      logger.warn("Authorization denied (fail-closed)", {
        reason: err.reason,
        detail: err.message,
        methodArn: event.methodArn,
      });
    } else {
      // Unexpected error — still fail closed, but log at ERROR for alarms.
      logger.error("Authorizer error; failing closed", err, {
        methodArn: event.methodArn,
      });
    }
    // API Gateway maps a thrown "Unauthorized" to a 401 response.
    throw new Error("Unauthorized");
  }
}
