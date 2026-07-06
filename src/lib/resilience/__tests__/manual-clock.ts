import type { Clock } from "../src/clock";

/**
 * Deterministic test clock. `sleep` advances virtual time instead of waiting on
 * the real event loop, so retry-backoff and breaker-cooldown behaviour can be
 * asserted with zero wall-clock delay.
 */
export class ManualClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }

  /** Manually jump virtual time forward (e.g. past a breaker cooldown). */
  advance(ms: number): void {
    this.t += ms;
  }
}
