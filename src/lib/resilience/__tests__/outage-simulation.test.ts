import { ResiliencePolicy } from "../src/policy";
import type { ResiliencePolicyOptions } from "../src/policy";
import { CircuitOpenError } from "../src/errors";
import { InMemoryMetricsSink } from "../src/metrics";
import type { BreakerState } from "../src/circuit-breaker";
import { ManualClock } from "./manual-clock";

/**
 * End-to-end outage simulation (the ADR-0004 chaos scenario):
 * a dependency goes down, the breaker trips and fast-fails / falls back, then
 * recovers through half-open probing back to closed.
 */
function outageHarness(): {
  policy: ResiliencePolicy;
  clock: ManualClock;
  metrics: InMemoryMetricsSink;
  setHealthy: (h: boolean) => void;
  opCalls: () => number;
  op: () => Promise<string>;
} {
  const clock = new ManualClock();
  const metrics = new InMemoryMetricsSink();
  let healthy = true;
  let calls = 0;

  const op = (): Promise<string> => {
    calls += 1;
    return healthy
      ? Promise.resolve("ok")
      : Promise.reject(new Error("dependency outage"));
  };

  const opts: ResiliencePolicyOptions = {
    dependency: "oidc-idp",
    timeoutMs: 1000,
    // One attempt per execute -> one breaker sample per call, for a clean sim.
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 4, totalBudgetMs: 500 },
    breaker: {
      failureThreshold: 0.5,
      rollingCount: 4,
      minimumThroughput: 4,
      openDurationMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 2,
    },
    metrics,
    clock,
    random: () => 0.5,
  };

  return {
    policy: new ResiliencePolicy(opts),
    clock,
    metrics,
    setHealthy: (h: boolean): void => {
      healthy = h;
    },
    opCalls: () => calls,
    op,
  };
}

function transitions(
  metrics: InMemoryMetricsSink,
): Array<[BreakerState, BreakerState]> {
  return metrics.ofType("breaker_transition").map((e) => [e.from, e.to]);
}

describe("outage simulation", () => {
  it("opens, fast-fails/falls back, half-opens after cooldown, and closes on recovery", async () => {
    const h = outageHarness();

    // Phase 1: healthy.
    await expect(h.policy.execute(h.op)).resolves.toBe("ok");
    expect(h.policy.breakerState).toBe("closed");

    // Phase 2: dependency goes down. The first outage call surfaces the raw
    // error (breaker still closed); further calls drive it to open.
    h.setHealthy(false);
    await expect(h.policy.execute(h.op)).rejects.toThrow("dependency outage");
    for (let i = 0; i < 6 && h.policy.breakerState !== "open"; i++) {
      await h.policy.execute(h.op).catch(() => undefined);
    }
    expect(h.policy.breakerState).toBe("open");
    expect(transitions(h.metrics)).toContainEqual(["closed", "open"]);

    // Phase 3a: while open with no fallback, the call fast-fails and never
    // touches the dependency (fail closed).
    const callsBeforeOpen = h.opCalls();
    await expect(h.policy.execute(h.op)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(h.opCalls()).toBe(callsBeforeOpen); // op was NOT invoked

    // Phase 3b: with a fallback, the open breaker serves the degraded path.
    const fallbackResult = await h.policy.execute(h.op, {
      fallback: () => "cached-jwks",
    });
    expect(fallbackResult).toBe("cached-jwks");
    expect(h.opCalls()).toBe(callsBeforeOpen); // still not invoked
    expect(
      h.metrics
        .ofType("fallback_activation")
        .some((e) => e.reason === "circuit_open"),
    ).toBe(true);

    // Phase 4: dependency recovers; after cooldown the breaker half-opens and
    // probes, then closes once enough probes succeed.
    h.setHealthy(true);
    h.clock.advance(100);

    await expect(h.policy.execute(h.op)).resolves.toBe("ok");
    expect(h.policy.breakerState).toBe("half-open");
    expect(transitions(h.metrics)).toContainEqual(["open", "half-open"]);

    await expect(h.policy.execute(h.op)).resolves.toBe("ok");
    expect(h.policy.breakerState).toBe("closed");
    expect(transitions(h.metrics)).toContainEqual(["half-open", "closed"]);
  });

  it("re-opens if the half-open probe still fails", async () => {
    const h = outageHarness();

    h.setHealthy(false);
    for (let i = 0; i < 4; i++) {
      await h.policy.execute(h.op).catch(() => undefined);
    }
    expect(h.policy.breakerState).toBe("open");

    // Cooldown passes but the dependency is still down.
    h.clock.advance(100);
    await h.policy.execute(h.op).catch(() => undefined); // probe fails
    expect(h.policy.breakerState).toBe("open");
  });

  it("keeps serving fallbacks during a sustained outage while the breaker is open", async () => {
    const h = outageHarness();
    h.setHealthy(false);

    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        await h.policy.execute(h.op, { fallback: () => "degraded" }),
      );
    }

    // Every call returned a value (never threw) and the breaker ended up open.
    expect(results.every((r) => r === "degraded")).toBe(true);
    expect(h.policy.breakerState).toBe("open");
  });
});
