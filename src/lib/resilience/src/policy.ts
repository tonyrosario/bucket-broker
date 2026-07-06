import { CircuitBreaker } from "./circuit-breaker";
import type { CircuitBreakerOptions, BreakerState } from "./circuit-breaker";
import { systemClock, systemRandom } from "./clock";
import type { Clock, RandomFn } from "./clock";
import { CircuitOpenError, IdempotencyConflictError } from "./errors";
import type { IdempotencyStore } from "./idempotency";
import { withIdempotency } from "./idempotency";
import { NoopMetricsSink } from "./metrics";
import type { FallbackReason, MetricsSink } from "./metrics";
import { runWithRetry } from "./retry";
import type { RetryOptions } from "./retry";
import { withTimeout } from "./timeout";

/** Context handed to a fallback so it can react to WHY the primary path failed. */
export interface FallbackContext {
  dependency: string;
  reason: FallbackReason;
  /** The underlying error, present when `reason === "operation_failed"`. */
  error?: unknown;
}

/** A defined per-dependency degraded path (ADR-0004 "defined fallbacks"). */
export type Fallback<T> = (ctx: FallbackContext) => Promise<T> | T;

export interface ResiliencePolicyOptions {
  dependency: string;
  /** Hard per-attempt timeout. */
  timeoutMs: number;
  retry: RetryOptions;
  /** Breaker thresholds; `dependency` is inherited from the policy. */
  breaker: Omit<CircuitBreakerOptions, "dependency">;
  /** Metrics sink; defaults to {@link NoopMetricsSink}. */
  metrics?: MetricsSink;
  /** Optional idempotency store + record TTL, enabling keyed dedupe. */
  idempotency?: { store: IdempotencyStore; ttlMs?: number };
  clock?: Clock;
  random?: RandomFn;
}

export interface ExecuteOptions<T> {
  /**
   * When set (and a store is configured), the operation runs at-most-once per
   * key: a completed key returns its cached result instead of re-running.
   */
  idempotencyKey?: string;
  /**
   * Degraded path used when the breaker is open OR the operation ultimately
   * fails. Omit it to fail closed (open breaker → {@link CircuitOpenError};
   * failure → the underlying error is rethrown). Fallback results are never
   * cached under the idempotency key.
   */
  fallback?: Fallback<T>;
}

/**
 * The full resilience envelope for one dependency: bounded timeout + circuit
 * breaker + jittered/budgeted retry + optional idempotency + metrics, composed
 * in that order.
 *
 * Composition (outer → inner) per `execute`:
 *   breaker gate → retry( idempotency( timeout( op ) ) )
 *
 * - The breaker records exactly one outcome per `execute` (not per retry), so a
 *   burst of transient blips inside one call counts as a single sample.
 * - Idempotency sits inside the retry so the SAME key guards every attempt and
 *   every re-invocation (client re-submit, breaker half-open re-entry, Step
 *   Functions redrive), while fallbacks stay outside it and are never cached.
 */
export class ResiliencePolicy {
  private readonly breaker: CircuitBreaker;
  private readonly metrics: MetricsSink;
  private readonly clock: Clock;
  private readonly random: RandomFn;

  constructor(private readonly opts: ResiliencePolicyOptions) {
    this.metrics = opts.metrics ?? new NoopMetricsSink();
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? systemRandom;
    this.breaker = new CircuitBreaker(
      { dependency: opts.dependency, ...opts.breaker },
      this.clock,
      (from, to) => {
        this.metrics.emit({
          type: "breaker_transition",
          dependency: opts.dependency,
          from,
          to,
          at: this.clock.now(),
        });
      },
    );
  }

  get dependency(): string {
    return this.opts.dependency;
  }

  get breakerState(): BreakerState {
    return this.breaker.currentState;
  }

  async execute<T>(
    op: () => Promise<T>,
    exec: ExecuteOptions<T> = {},
  ): Promise<T> {
    if (!this.breaker.tryAcquire()) {
      // Fail closed: open breaker + no fallback rejects fast, never succeeds.
      if (!exec.fallback) {
        throw new CircuitOpenError(this.opts.dependency);
      }
      return this.activateFallback(exec.fallback, "circuit_open");
    }

    const attempt = this.buildAttempt(op, exec.idempotencyKey);

    try {
      const result = await runWithRetry(attempt, this.opts.retry, {
        clock: this.clock,
        random: this.random,
        dependency: this.opts.dependency,
        onRetry: (attemptNo, delayMs) => {
          this.metrics.emit({
            type: "retry",
            dependency: this.opts.dependency,
            attempt: attemptNo,
            delayMs,
            at: this.clock.now(),
          });
        },
      });
      this.breaker.onSuccess();
      this.emitCallResult("success");
      return result;
    } catch (err) {
      // A same-key conflict means another in-flight call already holds this
      // idempotency reservation — client concurrency, exactly what idempotency
      // exists to absorb, NOT dependency ill-health. Recording it would let a
      // legitimate double-submit trip the breaker on a healthy dependency, and
      // absorbing it in a fallback would hide the concurrency from the loser.
      // Leave breaker state untouched, emit no failure metric, and surface it.
      if (err instanceof IdempotencyConflictError) {
        throw err;
      }
      this.breaker.onFailure();
      this.emitCallResult("failure");
      if (exec.fallback) {
        return this.activateFallback(exec.fallback, "operation_failed", err);
      }
      throw err;
    }
  }

  /** Per-attempt unit: idempotency (if keyed) wrapping the bounded call. */
  private buildAttempt<T>(
    op: () => Promise<T>,
    idempotencyKey?: string,
  ): () => Promise<T> {
    const bounded = (): Promise<T> =>
      withTimeout(op, this.opts.timeoutMs, this.opts.dependency);

    if (idempotencyKey !== undefined && this.opts.idempotency) {
      const { store, ttlMs } = this.opts.idempotency;
      return () =>
        withIdempotency(store, idempotencyKey, this.clock, bounded, ttlMs);
    }
    return bounded;
  }

  private async activateFallback<T>(
    fallback: Fallback<T>,
    reason: FallbackReason,
    error?: unknown,
  ): Promise<T> {
    this.metrics.emit({
      type: "fallback_activation",
      dependency: this.opts.dependency,
      reason,
      at: this.clock.now(),
    });
    return await fallback({ dependency: this.opts.dependency, reason, error });
  }

  private emitCallResult(outcome: "success" | "failure"): void {
    this.metrics.emit({
      type: "call_result",
      dependency: this.opts.dependency,
      outcome,
      at: this.clock.now(),
    });
  }
}
