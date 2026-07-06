import { TimeoutError } from "./errors";

/**
 * Bound an async operation with a hard timeout (ADR-0004: "no unbounded
 * waits"). If `op` does not settle within `timeoutMs`, the returned promise
 * rejects with a {@link TimeoutError}. The underlying operation is not
 * cancellable from here (JS promises have no cancellation), but the caller is
 * unblocked immediately so concurrency is never pinned by a hung dependency.
 */
export async function withTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number,
  dependency: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(dependency, timeoutMs));
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    op().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
