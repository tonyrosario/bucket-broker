import {
  ResiliencePolicy,
  ResilienceRegistry,
  CircuitBreaker,
  InMemoryIdempotencyStore,
  InMemoryMetricsSink,
  NoopMetricsSink,
  TimeoutError,
  CircuitOpenError,
  RetryBudgetExceededError,
  IdempotencyConflictError,
  ResilienceError,
  withTimeout,
  withIdempotency,
  runWithRetry,
  fullJitterDelay,
  systemClock,
  systemRandom,
} from "../src/index";

describe("public barrel export", () => {
  it("re-exports every documented symbol", () => {
    const symbols = [
      ResiliencePolicy,
      ResilienceRegistry,
      CircuitBreaker,
      InMemoryIdempotencyStore,
      InMemoryMetricsSink,
      NoopMetricsSink,
      TimeoutError,
      CircuitOpenError,
      RetryBudgetExceededError,
      IdempotencyConflictError,
      ResilienceError,
      withTimeout,
      withIdempotency,
      runWithRetry,
      fullJitterDelay,
    ];
    for (const symbol of symbols) {
      expect(symbol).toBeDefined();
    }
  });

  it("provides a working systemClock and systemRandom", async () => {
    const before = systemClock.now();
    expect(typeof before).toBe("number");
    await systemClock.sleep(1);
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);

    const r = systemRandom();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});
