import type { Clock } from "./clock";
import { IdempotencyConflictError } from "./errors";

export type IdempotencyStatus = "in_progress" | "completed";

/** A persisted record of a keyed operation's progress and cached result. */
export interface IdempotencyRecord {
  key: string;
  status: IdempotencyStatus;
  /** Present only once `status === "completed"`. */
  result?: unknown;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms after which the record may be reclaimed (maps to a Dynamo TTL). */
  ttlAt?: number;
}

/**
 * Pluggable idempotency store.
 *
 * The method shapes are chosen so a DynamoDB-backed implementation drops in
 * without changing callers:
 *  - {@link putIfAbsent} → `PutItem` with `ConditionExpression:
 *    attribute_not_exists(pk)` (the atomic reserve);
 *  - {@link get}         → `GetItem`;
 *  - {@link complete}    → `UpdateItem` setting status + result;
 *  - {@link release}     → `DeleteItem`.
 *
 * The in-memory default ({@link InMemoryIdempotencyStore}) is the reference
 * implementation and is safe because Node runs the reserve/complete steps on a
 * single thread; DynamoDB's conditional write provides the same atomicity across
 * distributed callers.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  /** Atomically insert `record` iff the key is absent. Returns `true` if inserted. */
  putIfAbsent(record: IdempotencyRecord): Promise<boolean>;
  /** Mark a reserved key completed and cache its result. */
  complete(key: string, result: unknown): Promise<void>;
  /** Drop a reservation so a later attempt may retry (used after a failure). */
  release(key: string): Promise<void>;
}

/** Single-process reference store backed by a `Map`. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.records.get(key);
    return Promise.resolve(record ? { ...record } : undefined);
  }

  putIfAbsent(record: IdempotencyRecord): Promise<boolean> {
    if (this.records.has(record.key)) {
      return Promise.resolve(false);
    }
    this.records.set(record.key, { ...record });
    return Promise.resolve(true);
  }

  complete(key: string, result: unknown): Promise<void> {
    const existing = this.records.get(key);
    if (existing) {
      existing.status = "completed";
      existing.result = result;
    }
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  /** Test/introspection helper. */
  size(): number {
    return this.records.size;
  }
}

/**
 * Run `op` at-most-once per `key`.
 *
 *  - key already `completed` → return the cached result WITHOUT running `op`
 *    (this is what stops a retry / re-submit / Step Functions redrive from
 *    double-provisioning);
 *  - key `in_progress` elsewhere → throw {@link IdempotencyConflictError}
 *    (fail closed rather than risk a concurrent duplicate);
 *  - key absent → reserve it, run `op`, cache on success, release on failure so
 *    a subsequent attempt is free to retry.
 *
 * Caveat: exactly-once under a crash mid-side-effect additionally requires the
 * downstream resource itself to be idempotent (e.g. a conditional bucket
 * create). This store guarantees single execution for the settled happy path
 * and deduplicates completed results.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  clock: Clock,
  op: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const existing = await store.get(key);
  if (existing?.status === "completed") {
    return existing.result as T;
  }

  const now = clock.now();
  const inserted = await store.putIfAbsent({
    key,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
    ttlAt: ttlMs !== undefined ? now + ttlMs : undefined,
  });

  if (!inserted) {
    const current = await store.get(key);
    if (current?.status === "completed") {
      return current.result as T;
    }
    throw new IdempotencyConflictError(key);
  }

  try {
    const result = await op();
    await store.complete(key, result);
    return result;
  } catch (err) {
    await store.release(key);
    throw err;
  }
}
