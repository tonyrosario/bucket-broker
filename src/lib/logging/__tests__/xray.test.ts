/**
 * Tests for the X-Ray integration helpers.
 *
 * We verify:
 *   1. No-op when the injected SDK is null (simulates SDK absent or daemon
 *      unreachable).
 *   2. No-op when resolveSegment() returns null or throws (no active trace).
 *   3. Correct addAnnotation() calls when SDK + segment are available.
 *   4. Correct addMetadata() calls.
 *   5. No exception surfaces to callers under any failure mode.
 *
 * Testing approach: rather than fighting Jest's module-cache (which caches the
 * jest.mock factory result on first require), xray.ts exposes
 * `_setXRaySdkForTest` / `_clearXRaySdkForTest` injection helpers. Tests set
 * these before calling annotateTrace/addTraceMetadata so the module never
 * touches require at all during tests.
 */

import {
  annotateTrace,
  addTraceMetadata,
  _setXRaySdkForTest,
  _clearXRaySdkForTest,
  XRaySdkLike,
  XRaySegmentLike,
} from "../src/xray";
import { Logger } from "../src/logger";

/** Build a mock segment with jest.fn() methods. */
function makeMockSegment(): {
  segment: XRaySegmentLike;
  addAnnotation: jest.Mock;
  addMetadata: jest.Mock;
} {
  const addAnnotation = jest.fn();
  const addMetadata = jest.fn();
  const segment: XRaySegmentLike = { addAnnotation, addMetadata };
  return { segment, addAnnotation, addMetadata };
}

/** Build an XRaySdkLike whose resolveSegment returns the given segment. */
function makeMockSdk(segment: XRaySegmentLike | null | undefined): XRaySdkLike {
  return {
    resolveSegment: () => segment,
  };
}

/** Build a mock SDK whose resolveSegment throws. */
function makeThrowingSdk(): XRaySdkLike {
  return {
    resolveSegment: () => {
      throw new Error("ContextMissingError: no active segment");
    },
  };
}

beforeEach(() => {
  // Reset injection before every test so tests are independent.
  _clearXRaySdkForTest();
});

afterAll(() => {
  _clearXRaySdkForTest();
});

// ─── annotateTrace — no SDK ───────────────────────────────────────────────────

describe("annotateTrace — no X-Ray SDK", () => {
  it("does not throw when SDK is null (not installed)", () => {
    _setXRaySdkForTest(null);
    expect(() => annotateTrace("corr-id-1")).not.toThrow();
  });

  it("does not throw with extra fields when SDK is null", () => {
    _setXRaySdkForTest(null);
    expect(() => annotateTrace("corr-id-2", { service: "svc", count: 1 })).not.toThrow();
  });
});

// ─── annotateTrace — SDK present, no active segment ──────────────────────────

describe("annotateTrace — SDK present, no active segment", () => {
  it("no-ops when resolveSegment returns null", () => {
    _setXRaySdkForTest(makeMockSdk(null));
    expect(() => annotateTrace("corr-id-3")).not.toThrow();
  });

  it("no-ops when resolveSegment returns undefined", () => {
    _setXRaySdkForTest(makeMockSdk(undefined));
    expect(() => annotateTrace("corr-id-4")).not.toThrow();
  });

  it("no-ops when resolveSegment throws (ContextMissingError)", () => {
    _setXRaySdkForTest(makeThrowingSdk());
    expect(() => annotateTrace("corr-id-5")).not.toThrow();
  });
});

// ─── annotateTrace — SDK present, active segment ─────────────────────────────

describe("annotateTrace — SDK present, active segment", () => {
  it("calls addAnnotation with correlationId", () => {
    const { segment, addAnnotation } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    annotateTrace("corr-abc");

    expect(addAnnotation).toHaveBeenCalledWith("correlationId", "corr-abc");
  });

  it("calls addAnnotation for each additional field", () => {
    const { segment, addAnnotation } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    annotateTrace("corr-xyz", { service: "my-svc", layer: "lambda", count: 3 });

    expect(addAnnotation).toHaveBeenCalledWith("correlationId", "corr-xyz");
    expect(addAnnotation).toHaveBeenCalledWith("service", "my-svc");
    expect(addAnnotation).toHaveBeenCalledWith("layer", "lambda");
    expect(addAnnotation).toHaveBeenCalledWith("count", 3);
  });

  it("calls addAnnotation exactly once for correlationId when no extra fields", () => {
    const { segment, addAnnotation } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    annotateTrace("only-id");

    const correlationCalls = (addAnnotation.mock.calls as [string, unknown][]).filter(
      ([key]) => key === "correlationId",
    );
    expect(correlationCalls).toHaveLength(1);
    expect(correlationCalls[0][1]).toBe("only-id");
  });

  it("does not call addAnnotation when SDK is null even if called twice", () => {
    const { segment, addAnnotation } = makeMockSegment();

    _setXRaySdkForTest(null);
    annotateTrace("call-1");

    // Now switch to real SDK
    _setXRaySdkForTest(makeMockSdk(segment));
    annotateTrace("call-2");

    // Only call-2 should have annotated
    expect(addAnnotation).toHaveBeenCalledTimes(1);
    expect(addAnnotation).toHaveBeenCalledWith("correlationId", "call-2");
  });
});

// ─── addTraceMetadata — no SDK ───────────────────────────────────────────────

describe("addTraceMetadata — no X-Ray SDK", () => {
  it("does not throw when SDK is null", () => {
    _setXRaySdkForTest(null);
    expect(() => addTraceMetadata("ns", { foo: "bar" })).not.toThrow();
  });

  it("does not throw when resolveSegment throws", () => {
    _setXRaySdkForTest(makeThrowingSdk());
    expect(() => addTraceMetadata("ns", { foo: "bar" })).not.toThrow();
  });
});

// ─── addTraceMetadata — SDK present ──────────────────────────────────────────

describe("addTraceMetadata — SDK present, active segment", () => {
  it("calls addMetadata with namespace and data object", () => {
    const { segment, addMetadata } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    addTraceMetadata("logging", { correlationId: "abc", service: "svc" });

    expect(addMetadata).toHaveBeenCalledWith(
      "logging",
      { correlationId: "abc", service: "svc" },
    );
  });

  it("does not call addAnnotation when addTraceMetadata is used", () => {
    const { segment, addAnnotation, addMetadata } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    addTraceMetadata("myns", { key: "val" });

    expect(addMetadata).toHaveBeenCalled();
    expect(addAnnotation).not.toHaveBeenCalled();
  });
});

// ─── Logger.annotateTrace (via logger.ts) ────────────────────────────────────

describe("Logger.annotateTrace integration", () => {
  it("calls annotateTrace with correlationId, service, layer", () => {
    const { segment, addAnnotation } = makeMockSegment();
    _setXRaySdkForTest(makeMockSdk(segment));

    const logger = new Logger({
      service: "test-svc",
      layer: "lambda",
      correlationId: "logger-corr-id",
      output: () => { /* noop */ },
    });
    logger.annotateTrace();

    expect(addAnnotation).toHaveBeenCalledWith("correlationId", "logger-corr-id");
    expect(addAnnotation).toHaveBeenCalledWith("service", "test-svc");
    expect(addAnnotation).toHaveBeenCalledWith("layer", "lambda");
  });

  it("does not throw when SDK is null", () => {
    _setXRaySdkForTest(null);
    const logger = new Logger({
      service: "svc",
      layer: "lyr",
      output: () => { /* noop */ },
    });
    expect(() => logger.annotateTrace()).not.toThrow();
  });
});
