/**
 * Error taxonomy for the resilience envelope. Each error is a distinct class so
 * callers (and tests) can branch on failure mode without string matching.
 */

/** Base class so callers can catch every resilience-originated failure at once. */
export class ResilienceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A wrapped call exceeded its bounded timeout. */
export class TimeoutError extends ResilienceError {
  constructor(
    public readonly dependency: string,
    public readonly timeoutMs: number,
  ) {
    super(`Call to "${dependency}" timed out after ${timeoutMs}ms`);
  }
}

/**
 * The circuit breaker is open (or half-open with no probe slots) and no
 * fallback was supplied. This is the fail-closed fast-reject path: the call
 * never reaches the dependency and never silently succeeds.
 */
export class CircuitOpenError extends ResilienceError {
  constructor(public readonly dependency: string) {
    super(`Circuit breaker for "${dependency}" is open; failing fast`);
  }
}

/**
 * Retries were abandoned because the next backoff sleep would exceed the
 * configured total-retry budget. Carries the last underlying error as `cause`.
 */
export class RetryBudgetExceededError extends ResilienceError {
  constructor(
    public readonly dependency: string,
    public readonly elapsedMs: number,
    public readonly budgetMs: number,
    cause: unknown,
  ) {
    super(
      `Retry budget for "${dependency}" exhausted (${elapsedMs}ms elapsed of ${budgetMs}ms budget)`,
      { cause },
    );
  }
}

/**
 * An idempotency key is already reserved (`in_progress`) by another in-flight
 * execution. Surfaced fail-closed rather than risking a duplicate side effect.
 */
export class IdempotencyConflictError extends ResilienceError {
  constructor(public readonly key: string) {
    super(`Idempotency key "${key}" is already in progress`);
  }
}
