/**
 * @bucket-broker/resilience
 *
 * Shared resilience helper implementing ADR-0004: every external dependency
 * call is wrapped in a bounded timeout + circuit breaker + jittered/budgeted
 * retry + optional idempotency, with pluggable metrics and defined fallbacks.
 *
 * Start with {@link ResiliencePolicy} (or {@link ResilienceRegistry} for the
 * "one breaker per dependency, reused across Lambdas" pattern).
 */
export { systemClock, systemRandom } from "./clock";
export type { Clock, RandomFn } from "./clock";

export {
  ResilienceError,
  ControlFlowError,
  TimeoutError,
  CircuitOpenError,
  RetryBudgetExceededError,
  IdempotencyConflictError,
} from "./errors";

export { withTimeout } from "./timeout";

export { defaultIsRetryable, fullJitterDelay, runWithRetry } from "./retry";
export type { RetryOptions, RetryContext } from "./retry";

export { CircuitBreaker } from "./circuit-breaker";
export type {
  BreakerState,
  CircuitBreakerOptions,
  OnTransition,
} from "./circuit-breaker";

export {
  InMemoryIdempotencyStore,
  withIdempotency,
} from "./idempotency";
export type {
  IdempotencyStore,
  IdempotencyRecord,
  IdempotencyStatus,
} from "./idempotency";

export { NoopMetricsSink, InMemoryMetricsSink } from "./metrics";
export type { MetricsSink, MetricEvent, FallbackReason } from "./metrics";

export { ResiliencePolicy } from "./policy";
export type {
  ResiliencePolicyOptions,
  ExecuteOptions,
  Fallback,
  FallbackContext,
} from "./policy";

export { ResilienceRegistry } from "./registry";
