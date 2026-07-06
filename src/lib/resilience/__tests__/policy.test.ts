import { ResiliencePolicy } from "../src/policy";
import type { ResiliencePolicyOptions } from "../src/policy";
import { InMemoryIdempotencyStore } from "../src/idempotency";
import { InMemoryMetricsSink } from "../src/metrics";
import { ManualClock } from "./manual-clock";

function baseOptions(
  overrides: Partial<ResiliencePolicyOptions> = {},
): ResiliencePolicyOptions {
  return {
    dependency: "idp",
    timeoutMs: 1000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      totalBudgetMs: 10_000,
    },
    // Thresholds high enough that these unit tests don't trip the breaker.
    breaker: {
      failureThreshold: 0.5,
      rollingCount: 100,
      minimumThroughput: 100,
      openDurationMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    },
    clock: new ManualClock(),
    random: () => 0.5,
    ...overrides,
  };
}

describe("ResiliencePolicy", () => {
  it("returns the operation result and records a success metric", async () => {
    const metrics = new InMemoryMetricsSink();
    const policy = new ResiliencePolicy(baseOptions({ metrics }));

    const result = await policy.execute(() => Promise.resolve("token"));

    expect(result).toBe("token");
    expect(policy.breakerState).toBe("closed");
    expect(metrics.ofType("call_result")[0].outcome).toBe("success");
  });

  it("uses the fallback when the operation ultimately fails", async () => {
    const metrics = new InMemoryMetricsSink();
    const policy = new ResiliencePolicy(
      baseOptions({ metrics, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 100 } }),
    );

    const result = await policy.execute(
      () => Promise.reject(new Error("idp down")),
      { fallback: () => "cached-keys" },
    );

    expect(result).toBe("cached-keys");
    const activations = metrics.ofType("fallback_activation");
    expect(activations).toHaveLength(1);
    expect(activations[0].reason).toBe("operation_failed");
  });

  it("rethrows the underlying error when no fallback is provided (fail closed)", async () => {
    const policy = new ResiliencePolicy(
      baseOptions({ retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 100 } }),
    );
    await expect(
      policy.execute(() => Promise.reject(new Error("idp down"))),
    ).rejects.toThrow("idp down");
  });

  it("retries transient failures and emits retry metrics", async () => {
    const metrics = new InMemoryMetricsSink();
    const policy = new ResiliencePolicy(baseOptions({ metrics }));
    let calls = 0;

    const result = await policy.execute(() => {
      calls += 1;
      return calls < 2
        ? Promise.reject(new Error("blip"))
        : Promise.resolve("ok");
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(metrics.ofType("retry")).toHaveLength(1);
  });

  it("dedupes side effects across calls sharing an idempotency key", async () => {
    const store = new InMemoryIdempotencyStore();
    const policy = new ResiliencePolicy(
      baseOptions({ idempotency: { store, ttlMs: 60_000 } }),
    );
    let sideEffects = 0;
    const op = (): Promise<string> => {
      sideEffects += 1;
      return Promise.resolve(`bucket-${sideEffects}`);
    };

    const first = await policy.execute(op, { idempotencyKey: "provision-42" });
    const second = await policy.execute(op, { idempotencyKey: "provision-42" });

    expect(first).toBe("bucket-1");
    expect(second).toBe("bucket-1");
    expect(sideEffects).toBe(1);
  });
});
