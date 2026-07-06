import { ResiliencePolicy, InMemoryMetricsSink } from "@bucket-broker/resilience";
import { Logger } from "@bucket-broker/logging";
import { JwksCache, type Jwk, type NowClock } from "../src/jwks";
import { AuthDenied } from "../src/errors";

const JWKS_URI = "https://idp.example.com/keys";

/** A logger that discards output so tests stay quiet. */
function silentLogger(): Logger {
  return new Logger({ service: "authorizer", layer: "lambda", correlationId: "test", output: () => undefined });
}

/** A hand-driven clock so TTL/throttle windows are deterministic. */
class ManualClock implements NowClock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function jwk(kid: string): Jwk {
  return { kty: "RSA", kid, use: "sig", alg: "RS256", n: "n", e: "AQAB" };
}

/** A policy with retries effectively disabled (deterministic, no real sleeps). */
function policy(metrics = new InMemoryMetricsSink()): ResiliencePolicy {
  return new ResiliencePolicy({
    dependency: "oidc-jwks",
    timeoutMs: 1000,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 10 },
    breaker: {
      failureThreshold: 0.5,
      rollingCount: 4,
      minimumThroughput: 2,
      openDurationMs: 10_000,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    },
    metrics,
  });
}

describe("JwksCache", () => {
  const logger = silentLogger();

  it("fetches and serves a key, then serves the fresh cache with no further fetch", async () => {
    const fetcher = jest.fn<Promise<Jwk[]>, [string]>().mockResolvedValue([jwk("k1")]);
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock });

    expect((await cache.getKey("k1", logger)).kid).toBe("k1");
    clock.advance(500); // still fresh
    expect((await cache.getKey("k1", logger)).kid).toBe("k1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cache goes stale", async () => {
    const fetcher = jest
      .fn<Promise<Jwk[]>, [string]>()
      .mockResolvedValueOnce([jwk("k1")])
      .mockResolvedValueOnce([jwk("k1"), jwk("k2")]);
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock });

    await cache.getKey("k1", logger);
    clock.advance(2000); // stale
    expect((await cache.getKey("k2", logger)).kid).toBe("k2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // ── The outage simulation required by issue #17 ──────────────────────────
  it("serves a stale cached key when the JWKS endpoint is unreachable (fail-open on availability)", async () => {
    const outage = new Error("ECONNREFUSED: JWKS endpoint unreachable");
    const fetcher = jest
      .fn<Promise<Jwk[]>, [string]>()
      .mockResolvedValueOnce([jwk("known")]) // healthy first load
      .mockRejectedValue(outage); // then the IdP goes down
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock });

    // Warm the cache while the IdP is healthy.
    expect((await cache.getKey("known", logger)).kid).toBe("known");

    // IdP outage: cache goes stale, refresh fails, but the KNOWN key still validates.
    clock.advance(5000);
    expect((await cache.getKey("known", logger)).kid).toBe("known");
    expect(fetcher).toHaveBeenCalledTimes(2); // a refresh WAS attempted
  });

  it("fails closed with unknown_kid when the key is absent even after a refresh attempt", async () => {
    const fetcher = jest
      .fn<Promise<Jwk[]>, [string]>()
      .mockResolvedValueOnce([jwk("known")])
      .mockRejectedValue(new Error("outage"));
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock });

    await cache.getKey("known", logger);
    clock.advance(5000);
    await expect(cache.getKey("attacker-kid", logger)).rejects.toMatchObject({ reason: "unknown_kid" });
  });

  it("fails closed with no_cached_key when the cache is empty and the fetch fails", async () => {
    const fetcher = jest.fn<Promise<Jwk[]>, [string]>().mockRejectedValue(new Error("down"));
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock: new ManualClock() });

    await expect(cache.getKey("anything", logger)).rejects.toBeInstanceOf(AuthDenied);
    await expect(cache.getKey("anything", logger)).rejects.toMatchObject({ reason: "no_cached_key" });
  });

  it("throttles refresh attempts within the min-refresh window", async () => {
    const fetcher = jest.fn<Promise<Jwk[]>, [string]>().mockResolvedValue([jwk("k1")]);
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 30_000, clock });

    await cache.getKey("k1", logger); // fetch #1
    clock.advance(2000); // stale, but inside the 30s throttle window
    await cache.getKey("k1", logger); // served stale; no new fetch
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refreshes into a single fetch", async () => {
    let resolveFetch!: (keys: Jwk[]) => void;
    const gate = new Promise<Jwk[]>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = jest.fn<Promise<Jwk[]>, [string]>().mockReturnValue(gate);
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: policy(), fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock: new ManualClock() });

    const p1 = cache.getKey("k1", logger);
    const p2 = cache.getKey("k1", logger);
    resolveFetch([jwk("k1")]);
    await Promise.all([p1, p2]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drives the resilience breaker: repeated fetch failures open it and are observable via metrics", async () => {
    const metrics = new InMemoryMetricsSink();
    const p = policy(metrics);
    const fetcher = jest.fn<Promise<Jwk[]>, [string]>().mockRejectedValue(new Error("persistent outage"));
    const clock = new ManualClock();
    const cache = new JwksCache({ jwksUri: JWKS_URI, policy: p, fetcher, ttlMs: 1000, minRefreshIntervalMs: 0, clock });

    // Hammer the failing dependency; each call attempts a refresh (throttle off).
    for (let i = 0; i < 6; i++) {
      await expect(cache.getKey("k1", logger)).rejects.toBeInstanceOf(AuthDenied);
      clock.advance(1);
    }

    // The breaker tripped open and short-circuited later refreshes (fail-fast).
    expect(p.breakerState).toBe("open");
    const transitions = metrics.events.filter((e) => e.type === "breaker_transition");
    expect(transitions.some((e) => "to" in e && e.to === "open")).toBe(true);
  });
});
