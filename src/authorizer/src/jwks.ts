/**
 * JWKS cache with TTL + stale-while-revalidate, wrapped in the shared
 * resilience helper (`@bucket-broker/resilience`).
 *
 * Fail-closed availability trade (ADR-0004):
 *   • Signing keys are cached in-process (per warm Lambda container).
 *   • A fresh cache that contains the requested `kid` is served with no network
 *     hop.
 *   • A stale cache (past TTL) triggers a refresh; the fetch runs inside a
 *     ResiliencePolicy (bounded timeout + circuit breaker + jittered retry). If
 *     that refresh FAILS or the breaker is open, we keep the existing keys and
 *     serve them stale — so a holder of a valid, unexpired token keeps working
 *     during an IdP/JWKS outage.
 *   • If the requested `kid` is absent even after a refresh attempt, we fail
 *     closed: `unknown_kid` when we hold other keys, `no_cached_key` when the
 *     cache is empty. Neither ever produces an Allow.
 *
 * The breaker is the reason a JWKS outage does not stall every request: once it
 * opens, refreshes short-circuit instantly and every call is served from the
 * (stale) cache until the breaker half-opens and a probe succeeds.
 */

import type { ResiliencePolicy } from "@bucket-broker/resilience";
import type { Logger } from "@bucket-broker/logging";
import { AuthDenied } from "./errors";

/** A JSON Web Key. Only the fields the authorizer inspects are typed. */
export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [param: string]: unknown;
}

/** Fetches and parses the JWKS document, returning its `keys` array. */
export type JwksFetcher = (jwksUri: string) => Promise<Jwk[]>;

/** Minimal clock so tests can drive TTL/throttle logic deterministically. */
export interface NowClock {
  now(): number;
}

const systemNowClock: NowClock = { now: () => Date.now() };

export interface JwksCacheOptions {
  jwksUri: string;
  /** Resilience envelope for the JWKS fetch (timeout + breaker + retry). */
  policy: ResiliencePolicy;
  fetcher: JwksFetcher;
  /** Freshness window; a cache older than this is refreshed on next use. */
  ttlMs: number;
  /**
   * Minimum spacing between refresh attempts. Prevents a burst of unknown-`kid`
   * tokens (or a sustained outage) from hammering the IdP; the resilience
   * breaker is the primary guard, this is a cheap second one.
   */
  minRefreshIntervalMs: number;
  clock?: NowClock;
}

/**
 * The default HTTPS fetcher using the Node global `fetch`. Injected in tests so
 * no real network call is made. The per-attempt timeout is enforced by the
 * ResiliencePolicy that wraps this call.
 */
export const httpsJwksFetcher: JwksFetcher = async (jwksUri: string): Promise<Jwk[]> => {
  const res = await fetch(jwksUri, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`JWKS endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) {
    throw new Error("JWKS response has no 'keys' array");
  }
  return body.keys.filter((k): k is Jwk => typeof k === "object" && k !== null);
};

export class JwksCache {
  private keysByKid = new Map<string, Jwk>();
  private fetchedAtMs = 0;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private readonly clock: NowClock;

  constructor(private readonly opts: JwksCacheOptions) {
    this.clock = opts.clock ?? systemNowClock;
  }

  private isFresh(): boolean {
    return this.keysByKid.size > 0 && this.clock.now() - this.fetchedAtMs < this.opts.ttlMs;
  }

  /**
   * Resolve the signing key for a `kid`, refreshing the cache when needed.
   * Throws {@link AuthDenied} (`unknown_kid` / `no_cached_key`) when the key
   * cannot be produced — the fail-closed path.
   */
  async getKey(kid: string, logger: Logger): Promise<Jwk> {
    // Fast path: a fresh cache that already holds the key — no network.
    const cached = this.keysByKid.get(kid);
    if (cached && this.isFresh()) {
      return cached;
    }

    // Stale, or a `kid` we have not seen (possible key rotation): try to
    // (re)load. On failure the existing keys are retained (stale-serve).
    await this.maybeRefresh(logger);

    const key = this.keysByKid.get(kid);
    if (key) {
      return key;
    }
    if (this.keysByKid.size === 0) {
      throw new AuthDenied("no_cached_key", "No JWKS keys cached and refresh unavailable");
    }
    throw new AuthDenied("unknown_kid", `No JWKS key matches kid after refresh`);
  }

  /** Coalesce concurrent refreshes and throttle their frequency. */
  private async maybeRefresh(logger: Logger): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const now = this.clock.now();
    if (now - this.lastAttemptMs < this.opts.minRefreshIntervalMs) {
      // Throttled: serve whatever we currently hold (fail-closed if empty).
      return;
    }
    this.lastAttemptMs = now;
    this.inflight = this.refresh(logger).finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async refresh(logger: Logger): Promise<void> {
    try {
      const keys = await this.opts.policy.execute(() => this.opts.fetcher(this.opts.jwksUri));
      const next = new Map<string, Jwk>();
      for (const key of keys) {
        if (typeof key.kid === "string") {
          next.set(key.kid, key);
        }
      }
      this.keysByKid = next;
      this.fetchedAtMs = this.clock.now();
      logger.info("JWKS cache refreshed", {
        keyCount: next.size,
        breakerState: this.opts.policy.breakerState,
      });
    } catch (err) {
      // Stale-while-revalidate: keep the current (stale) keys so valid tokens
      // keep validating during the outage. Fail-closed is enforced by getKey
      // when the requested kid is absent from the retained cache.
      logger.warn("JWKS refresh failed; serving stale cache (fail-closed on unknown kid)", {
        breakerState: this.opts.policy.breakerState,
        cachedKeyCount: this.keysByKid.size,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
