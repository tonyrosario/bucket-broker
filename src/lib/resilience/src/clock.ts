/**
 * Injectable time source.
 *
 * Every time-dependent component (retry backoff, circuit-breaker cooldown,
 * idempotency TTL) reads the clock through this interface so tests can drive
 * time deterministically instead of sleeping in real wall-clock. Production
 * code uses {@link systemClock}.
 */
export interface Clock {
  /** Milliseconds since the epoch (monotonic-ish; only deltas are used). */
  now(): number;
  /** Resolve after roughly `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** Real clock backed by `Date.now` and `setTimeout`. */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Do not keep the event loop alive purely for a backoff sleep.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
  },
};

/** Source of randomness in the half-open `[0, 1)` range, injectable for tests. */
export type RandomFn = () => number;

/** Default randomness backed by `Math.random`. */
export const systemRandom: RandomFn = () => Math.random();
