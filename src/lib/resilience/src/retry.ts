import type { Clock, RandomFn } from "./clock";
import { RetryBudgetExceededError } from "./errors";

/** Retry configuration. All delays are in milliseconds. */
export interface RetryOptions {
  /** Total attempts INCLUDING the first try (>= 1). `1` disables retries. */
  maxAttempts: number;
  /** Base backoff before jitter, doubled each retry. */
  baseDelayMs: number;
  /** Per-attempt ceiling on the (pre-jitter) exponential backoff. */
  maxDelayMs: number;
  /**
   * Total wall-clock budget for all backoff sleeps combined. Retrying stops the
   * moment the next sleep would push cumulative backoff past this budget, so the
   * envelope never blows the caller's slice of the 10-minute platform SLO.
   */
  totalBudgetMs: number;
  /**
   * Classifies an error as transient/retryable. Defaults to "retry everything".
   * Non-retryable errors (e.g. a 4xx) short-circuit immediately.
   */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Full-jitter backoff (AWS "Exponential Backoff And Jitter"): the sleep is drawn
 * uniformly from `[0, min(maxDelayMs, baseDelayMs * 2^retryIndex))`. Full jitter
 * (as opposed to equal/decorrelated jitter) minimises contention by spreading
 * retries across the whole window. Exposed for direct unit testing of the caps.
 *
 * @param retryIndex zero-based index of the retry (0 = first backoff).
 * @param rand a value in `[0, 1)`.
 */
export function fullJitterDelay(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  rand: number,
): number {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * Math.pow(2, retryIndex),
  );
  return Math.floor(rand * exponential);
}

export interface RetryContext {
  clock: Clock;
  random: RandomFn;
  dependency: string;
  /** Notified before each backoff sleep, for metrics. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Execute `op`, retrying transient failures with full-jitter exponential
 * backoff, bounded by both `maxAttempts` and `totalBudgetMs`.
 *
 * Termination:
 *  - success  → resolves with the value;
 *  - non-retryable error → rejects with that error immediately;
 *  - attempts exhausted  → rejects with the last error;
 *  - budget would be exceeded → rejects with {@link RetryBudgetExceededError}
 *    (carrying the last error as `cause`), guaranteeing the budget is a hard cap.
 */
export async function runWithRetry<T>(
  op: () => Promise<T>,
  opts: RetryOptions,
  ctx: RetryContext,
): Promise<T> {
  const start = ctx.clock.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;

      const retryable = opts.isRetryable ? opts.isRetryable(err) : true;
      if (!retryable || attempt >= opts.maxAttempts) {
        throw err;
      }

      const delay = fullJitterDelay(
        attempt - 1,
        opts.baseDelayMs,
        opts.maxDelayMs,
        ctx.random(),
      );
      const elapsed = ctx.clock.now() - start;
      if (elapsed + delay > opts.totalBudgetMs) {
        throw new RetryBudgetExceededError(
          ctx.dependency,
          elapsed,
          opts.totalBudgetMs,
          err,
        );
      }

      ctx.onRetry?.(attempt, delay, err);
      await ctx.clock.sleep(delay);
    }
  }

  // Unreachable: the loop either returns or throws. Present for exhaustiveness.
  throw lastErr;
}
