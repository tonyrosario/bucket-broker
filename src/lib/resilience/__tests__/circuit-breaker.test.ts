import { CircuitBreaker } from "../src/circuit-breaker";
import type { BreakerState, CircuitBreakerOptions } from "../src/circuit-breaker";
import { ManualClock } from "./manual-clock";

function makeBreaker(
  overrides: Partial<CircuitBreakerOptions> = {},
): {
  breaker: CircuitBreaker;
  clock: ManualClock;
  transitions: Array<[BreakerState, BreakerState]>;
} {
  const clock = new ManualClock();
  const transitions: Array<[BreakerState, BreakerState]> = [];
  const opts: CircuitBreakerOptions = {
    dependency: "test-dep",
    failureThreshold: 0.5,
    rollingCount: 4,
    minimumThroughput: 4,
    openDurationMs: 100,
    halfOpenMaxProbes: 1,
    successThreshold: 2,
    ...overrides,
  };
  const breaker = new CircuitBreaker(opts, clock, (from, to) =>
    transitions.push([from, to]),
  );
  return { breaker, clock, transitions };
}

describe("CircuitBreaker", () => {
  it("starts closed and allows calls", () => {
    const { breaker } = makeBreaker();
    expect(breaker.currentState).toBe("closed");
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("does not trip below the minimum throughput", () => {
    const { breaker } = makeBreaker({ minimumThroughput: 4 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.currentState).toBe("closed");
  });

  it("opens once the failure ratio crosses the threshold", () => {
    const { breaker, transitions } = makeBreaker();
    for (let i = 0; i < 4; i++) {
      breaker.tryAcquire();
      breaker.onFailure();
    }
    expect(breaker.currentState).toBe("open");
    expect(transitions).toContainEqual(["closed", "open"]);
  });

  it("fast-fails (tryAcquire false) while open before the cooldown", () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 4; i++) breaker.onFailure();
    expect(breaker.currentState).toBe("open");
    expect(breaker.tryAcquire()).toBe(false);
  });

  it("transitions to half-open after the cooldown and probes", () => {
    const { breaker, clock, transitions } = makeBreaker();
    for (let i = 0; i < 4; i++) breaker.onFailure();
    clock.advance(100);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.currentState).toBe("half-open");
    expect(transitions).toContainEqual(["open", "half-open"]);
  });

  it("limits concurrent probes while half-open", () => {
    const { breaker, clock } = makeBreaker({ halfOpenMaxProbes: 1 });
    for (let i = 0; i < 4; i++) breaker.onFailure();
    clock.advance(100);
    expect(breaker.tryAcquire()).toBe(true); // probe slot taken
    expect(breaker.tryAcquire()).toBe(false); // no slots left
  });

  it("closes after enough consecutive half-open successes", () => {
    const { breaker, clock, transitions } = makeBreaker({
      successThreshold: 2,
    });
    for (let i = 0; i < 4; i++) breaker.onFailure();
    clock.advance(100);
    breaker.tryAcquire();
    breaker.onSuccess(); // 1st probe success
    expect(breaker.currentState).toBe("half-open");
    breaker.tryAcquire();
    breaker.onSuccess(); // 2nd probe success -> close
    expect(breaker.currentState).toBe("closed");
    expect(transitions).toContainEqual(["half-open", "closed"]);
  });

  it("re-opens if a half-open probe fails", () => {
    const { breaker, clock, transitions } = makeBreaker();
    for (let i = 0; i < 4; i++) breaker.onFailure();
    clock.advance(100);
    breaker.tryAcquire();
    breaker.onFailure(); // probe fails -> re-open
    expect(breaker.currentState).toBe("open");
    expect(
      transitions.filter(([, to]) => to === "open").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("resets its window after recovering to closed", () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 4; i++) breaker.onFailure();
    clock.advance(100);
    breaker.tryAcquire();
    breaker.onSuccess();
    breaker.tryAcquire();
    breaker.onSuccess(); // closed, window cleared
    // A single fresh failure must not immediately re-trip (window was reset).
    breaker.onFailure();
    expect(breaker.currentState).toBe("closed");
  });
});
