import { ResilienceRegistry } from "../src/registry";
import type { ResiliencePolicyOptions } from "../src/policy";
import { ManualClock } from "./manual-clock";

function opts(dependency: string): ResiliencePolicyOptions {
  return {
    dependency,
    timeoutMs: 1000,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 100 },
    breaker: {
      failureThreshold: 0.5,
      rollingCount: 4,
      minimumThroughput: 4,
      openDurationMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    },
    clock: new ManualClock(),
    random: () => 0.5,
  };
}

describe("ResilienceRegistry", () => {
  it("registers and retrieves a policy per dependency", () => {
    const registry = new ResilienceRegistry();
    const policy = registry.register(opts("idp"));
    expect(registry.get("idp")).toBe(policy);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("getOrRegister returns the same instance on subsequent calls", () => {
    const registry = new ResilienceRegistry();
    const first = registry.getOrRegister(opts("notifier"));
    const second = registry.getOrRegister(opts("notifier"));
    expect(second).toBe(first);
  });
});
