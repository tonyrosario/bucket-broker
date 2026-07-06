import { fullJitterDelay, runWithRetry } from "../src/retry";
import type { RetryOptions } from "../src/retry";
import { RetryBudgetExceededError } from "../src/errors";
import { ManualClock } from "./manual-clock";

describe("fullJitterDelay", () => {
  it("returns 0 when the random draw is 0", () => {
    expect(fullJitterDelay(5, 100, 1000, 0)).toBe(0);
  });

  it("never exceeds the exponential window (base * 2^i) for any draw", () => {
    const base = 50;
    const cap = 10_000;
    for (let index = 0; index < 6; index++) {
      const window = Math.min(cap, base * Math.pow(2, index));
      for (const rand of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const delay = fullJitterDelay(index, base, cap, rand);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(window + 1);
        expect(delay).toBeLessThanOrEqual(window);
      }
    }
  });

  it("respects the per-attempt max-delay cap", () => {
    // base * 2^10 would be huge; cap must dominate.
    const delay = fullJitterDelay(10, 100, 500, 0.999999);
    expect(delay).toBeLessThanOrEqual(500);
  });
});

describe("runWithRetry", () => {
  const baseOpts: RetryOptions = {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    totalBudgetMs: 10_000,
  };

  function ctx(
    clock = new ManualClock(),
    rand = 0.5,
  ): { clock: ManualClock; random: () => number; dependency: string } {
    return { clock, random: (): number => rand, dependency: "dep" };
  }

  it("returns the value on first success without sleeping", async () => {
    const clock = new ManualClock();
    const result = await runWithRetry(
      () => Promise.resolve("ok"),
      baseOpts,
      ctx(clock),
    );
    expect(result).toBe("ok");
    expect(clock.now()).toBe(0);
  });

  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const result = await runWithRetry(
      () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new Error("transient"))
          : Promise.resolve("recovered");
      },
      baseOpts,
      ctx(),
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("stops immediately on a non-retryable error", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("fatal"));
        },
        { ...baseOpts, isRetryable: () => false },
        ctx(),
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("throws the last error once maxAttempts is exhausted", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error(`boom-${calls}`));
        },
        { ...baseOpts, maxAttempts: 3, totalBudgetMs: 10_000 },
        ctx(),
      ),
    ).rejects.toThrow("boom-3");
    expect(calls).toBe(3);
  });

  it("stops at the retry budget and never exceeds it", async () => {
    let calls = 0;
    const clock = new ManualClock();
    // With rand=0.5: backoffs are 50, 100, 200, 400...
    // budget 500 -> the 400 backoff (cumulative would be 750) is refused.
    await expect(
      runWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("outage"));
        },
        {
          maxAttempts: 10,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          totalBudgetMs: 500,
        },
        ctx(clock),
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExceededError);
    expect(calls).toBe(4);
    expect(clock.now()).toBeLessThanOrEqual(500);
  });

  it("carries the last underlying error as the budget error cause", async () => {
    const clock = new ManualClock();
    const err = await runWithRetry(
      () => Promise.reject(new Error("root-cause")),
      { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1000, totalBudgetMs: 10 },
      ctx(clock),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryBudgetExceededError);
    expect((err as RetryBudgetExceededError).cause).toBeInstanceOf(Error);
    expect(((err as RetryBudgetExceededError).cause as Error).message).toBe(
      "root-cause",
    );
  });
});
