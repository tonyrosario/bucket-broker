import type { Clock } from "./clock";

/** Breaker lifecycle states (ADR-0004: closed → open → half-open). */
export type BreakerState = "closed" | "open" | "half-open";

/** Per-dependency circuit-breaker thresholds. */
export interface CircuitBreakerOptions {
  dependency: string;
  /**
   * Failure ratio in `(0, 1]` over the rolling window that trips the breaker
   * (e.g. `0.5` = open once half of the recent calls fail).
   */
  failureThreshold: number;
  /** Size of the rolling window of recent outcomes. */
  rollingCount: number;
  /** Minimum samples in the window before the ratio can trip the breaker. */
  minimumThroughput: number;
  /** How long the breaker stays open before allowing a half-open probe. */
  openDurationMs: number;
  /** Max concurrent trial calls permitted while half-open. */
  halfOpenMaxProbes: number;
  /** Consecutive half-open successes required to close the breaker. */
  successThreshold: number;
}

/** Called on every state change so the policy layer can emit a metric. */
export type OnTransition = (from: BreakerState, to: BreakerState) => void;

/**
 * A single-dependency circuit breaker.
 *
 * State is intentionally held in-process (per warm Lambda container). That is
 * the right granularity for shedding load off a slow dependency: each container
 * independently trips, probes, and recovers. Cross-container coordination is
 * explicitly out of scope (see ADR-0004).
 *
 * Usage contract: call {@link tryAcquire} before invoking the dependency. If it
 * returns `true` you MUST later call exactly one of {@link onSuccess} /
 * {@link onFailure}. If it returns `false`, short-circuit (fail fast/fallback).
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  /** Rolling window of recent outcomes; `true` = success. */
  private outcomes: boolean[] = [];
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;

  constructor(
    private readonly opts: CircuitBreakerOptions,
    private readonly clock: Clock,
    private readonly onTransition: OnTransition = () => undefined,
  ) {
    // Reject misconfiguration that would silently fail OPEN (a breaker that can
    // never trip, or trips on garbage) instead of surfacing it at wiring time.
    if (opts.failureThreshold <= 0 || opts.failureThreshold > 1) {
      throw new RangeError(
        `CircuitBreaker "${opts.dependency}": failureThreshold must be in (0, 1], got ${opts.failureThreshold}`,
      );
    }
    if (opts.minimumThroughput > opts.rollingCount) {
      throw new RangeError(
        `CircuitBreaker "${opts.dependency}": minimumThroughput (${opts.minimumThroughput}) must be <= rollingCount (${opts.rollingCount}); otherwise the window can never satisfy the throughput gate and the breaker never trips`,
      );
    }
    if (opts.halfOpenMaxProbes < 1) {
      throw new RangeError(
        `CircuitBreaker "${opts.dependency}": halfOpenMaxProbes must be >= 1, got ${opts.halfOpenMaxProbes}`,
      );
    }
  }

  get currentState(): BreakerState {
    return this.state;
  }

  get dependency(): string {
    return this.opts.dependency;
  }

  /**
   * Decide whether a call may proceed, advancing open → half-open once the
   * cooldown has elapsed and reserving a probe slot when half-open.
   */
  tryAcquire(): boolean {
    switch (this.state) {
      case "closed":
        return true;
      case "open":
        if (this.clock.now() - this.openedAt >= this.opts.openDurationMs) {
          this.transition("half-open");
          this.halfOpenInFlight = 1;
          this.halfOpenSuccesses = 0;
          return true;
        }
        return false;
      case "half-open":
        if (this.halfOpenInFlight < this.opts.halfOpenMaxProbes) {
          this.halfOpenInFlight += 1;
          return true;
        }
        return false;
    }
  }

  onSuccess(): void {
    // A probe from a prior generation can settle after the breaker has already
    // re-opened. Ignore it so it can never leak into the next closed window.
    if (this.state === "open") {
      return;
    }
    if (this.state === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.opts.successThreshold) {
        this.reset();
        this.transition("closed");
      }
      return;
    }
    this.record(true);
  }

  onFailure(): void {
    // Straggler from a prior generation (see onSuccess): the breaker is already
    // open, so this outcome is stale — drop it rather than record it.
    if (this.state === "open") {
      return;
    }
    if (this.state === "half-open") {
      // Any failure during probing re-opens the breaker for another cooldown.
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.open();
      return;
    }
    this.record(false);
    if (this.state === "closed" && this.shouldTrip()) {
      this.open();
    }
  }

  private record(success: boolean): void {
    this.outcomes.push(success);
    if (this.outcomes.length > this.opts.rollingCount) {
      this.outcomes.shift();
    }
  }

  private shouldTrip(): boolean {
    if (this.outcomes.length < this.opts.minimumThroughput) {
      return false;
    }
    const failures = this.outcomes.filter((ok) => !ok).length;
    return failures / this.outcomes.length >= this.opts.failureThreshold;
  }

  private open(): void {
    this.openedAt = this.clock.now();
    this.transition("open");
  }

  private reset(): void {
    this.outcomes = [];
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
  }

  private transition(to: BreakerState): void {
    if (this.state === to) {
      return;
    }
    const from = this.state;
    this.state = to;
    this.onTransition(from, to);
  }
}
