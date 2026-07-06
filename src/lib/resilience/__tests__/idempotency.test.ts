import {
  InMemoryIdempotencyStore,
  withIdempotency,
} from "../src/idempotency";
import { IdempotencyConflictError } from "../src/errors";
import { ManualClock } from "./manual-clock";

describe("InMemoryIdempotencyStore", () => {
  it("inserts once and refuses a second insert for the same key", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = 1;
    expect(
      await store.putIfAbsent({
        key: "k",
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      }),
    ).toBe(true);
    expect(
      await store.putIfAbsent({
        key: "k",
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      }),
    ).toBe(false);
  });

  it("completes and returns a cached result; release removes the record", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.putIfAbsent({
      key: "k",
      status: "in_progress",
      createdAt: 0,
      updatedAt: 0,
    });
    await store.complete("k", { bucket: "b-1" });
    const rec = await store.get("k");
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toEqual({ bucket: "b-1" });

    await store.release("k");
    expect(await store.get("k")).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe("withIdempotency", () => {
  const clock = new ManualClock();

  it("runs the operation only once for a repeated key (no double side effect)", async () => {
    const store = new InMemoryIdempotencyStore();
    let sideEffects = 0;
    const op = (): Promise<string> => {
      sideEffects += 1;
      return Promise.resolve(`bucket-${sideEffects}`);
    };

    const first = await withIdempotency(store, "provision-1", clock, op);
    const second = await withIdempotency(store, "provision-1", clock, op);

    expect(first).toBe("bucket-1");
    expect(second).toBe("bucket-1"); // cached, not re-run
    expect(sideEffects).toBe(1);
  });

  it("throws a conflict when the key is reserved and not yet completed", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.putIfAbsent({
      key: "in-flight",
      status: "in_progress",
      createdAt: 0,
      updatedAt: 0,
    });
    await expect(
      withIdempotency(store, "in-flight", clock, () => Promise.resolve("x")),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("releases the reservation on failure so a later attempt can retry", async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(
      withIdempotency(store, "k", clock, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(store.size()).toBe(0);

    // Key is free again -> a fresh attempt runs.
    const result = await withIdempotency(store, "k", clock, () =>
      Promise.resolve("ok"),
    );
    expect(result).toBe("ok");
  });

  it("stamps a TTL when ttlMs is provided", async () => {
    const store = new InMemoryIdempotencyStore();
    const localClock = new ManualClock(1000);
    await withIdempotency(
      store,
      "ttl-key",
      localClock,
      () => Promise.resolve("v"),
      500,
    );
    const rec = await store.get("ttl-key");
    expect(rec?.ttlAt).toBe(1500);
  });
});
