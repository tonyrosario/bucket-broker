import { withTimeout } from "../src/timeout";
import { TimeoutError } from "../src/errors";

describe("withTimeout", () => {
  it("resolves when the operation finishes within the bound", async () => {
    const result = await withTimeout(() => Promise.resolve(42), 1000, "dep");
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when the operation is too slow", async () => {
    const slow = (): Promise<number> =>
      new Promise<number>((resolve) => {
        const t = setTimeout(() => resolve(1), 200);
        if (typeof t.unref === "function") t.unref();
      });
    await expect(withTimeout(slow, 20, "slow-dep")).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("propagates the underlying rejection (and clears the timer)", async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error("upstream")), 1000, "dep"),
    ).rejects.toThrow("upstream");
  });

  it("wraps a non-Error rejection into an Error", async () => {
    await expect(
      withTimeout(() => Promise.reject("string-fail"), 1000, "dep"),
    ).rejects.toBeInstanceOf(Error);
  });

  it("surfaces a synchronous throw from op as a rejection (no timer leak)", async () => {
    const setSpy = jest.spyOn(global, "setTimeout");
    const clearSpy = jest.spyOn(global, "clearTimeout");
    try {
      await expect(
        withTimeout(() => {
          throw new Error("sync-boom");
        }, 1000, "dep"),
      ).rejects.toThrow("sync-boom");
      // Every timer that was armed for this call was also cleared.
      expect(clearSpy).toHaveBeenCalledTimes(setSpy.mock.calls.length);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
