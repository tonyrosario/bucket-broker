/**
 * X-Ray trace annotation helpers — optional, gracefully degraded.
 *
 * Design
 * ───────
 * The bucket-broker platform uses AWS X-Ray for distributed tracing (see
 * architecture.md: "X-Ray end-to-end"). However, X-Ray is only present at
 * runtime inside a traced Lambda invocation or ECS task; it is never
 * available in local development or test environments.
 *
 * This module attempts to dynamically require `aws-xray-sdk-core` at call
 * time. If the SDK is not installed, not on PATH, or the current execution is
 * not running inside an X-Ray segment (daemon not reachable), every function
 * here silently no-ops. No exception is ever surfaced to callers.
 *
 * Runtime dependency
 * ───────────────────
 * `aws-xray-sdk-core` is NOT listed as a package.json dependency. If
 * platform Lambdas want to use it, they must install it themselves. This
 * library merely provides the integration seam. This keeps the logging
 * library dependency-free.
 *
 * When X-Ray IS present:
 *   annotateTrace()    → segment.addAnnotation(key, value) for each field
 *   addTraceMetadata() → segment.addMetadata(key, data, namespace)
 *
 * Annotations are indexed and filterable in the X-Ray console; metadata is
 * stored but not indexed.
 */

/** Minimal interface for the subset of aws-xray-sdk-core we need. */
export interface XRaySegmentLike {
  addAnnotation(key: string, value: string | number | boolean): void;
  addMetadata(key: string, value: unknown, namespace?: string): void;
}

/** Minimal interface for the X-Ray SDK surface we use. */
export interface XRaySdkLike {
  resolveSegment(): XRaySegmentLike | null | undefined;
}

/**
 * Attempt to load aws-xray-sdk-core. Returns null if not installed.
 * Cached after the first successful or failed load.
 *
 * @internal
 */
let _xrayCache: XRaySdkLike | null | undefined = undefined;

/**
 * Optional test-only injection point.  When set (not undefined), tryLoadXRay
 * returns this value directly without touching require or the cache.
 *
 * @internal
 */
let _testSdk: XRaySdkLike | null | undefined = undefined;
/** True when _setXRaySdkForTest has been called; distinguishes "not set" from "set to null". */
let _testSdkSet = false;

function tryLoadXRay(): XRaySdkLike | null {
  // Test injection: allows unit tests to supply a mock or null without needing
  // to stub the module system.
  if (_testSdkSet) return _testSdk ?? null;

  if (_xrayCache !== undefined) return _xrayCache;
  try {
    // Dynamic require is intentional — we don't want a hard compile-time dep.
    // aws-xray-sdk-core is only available at Lambda runtime; we degrade
    // gracefully when it is absent. The eslint suppression is intentional.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _xrayCache = require("aws-xray-sdk-core") as XRaySdkLike;
  } catch {
    _xrayCache = null;
  }
  return _xrayCache;
}

/**
 * Inject a mock X-Ray SDK for testing.  Pass `null` to simulate the SDK
 * being absent.  Call `_clearXRaySdkForTest()` in `afterEach` to restore
 * normal behaviour.
 *
 * @internal — for unit tests only; do not call in production code.
 */
export function _setXRaySdkForTest(sdk: XRaySdkLike | null): void {
  _testSdk = sdk;
  _testSdkSet = true;
}

/**
 * Clear the test injection and the runtime cache, restoring normal SDK
 * loading behaviour.
 *
 * @internal — for unit tests only.
 */
export function _clearXRaySdkForTest(): void {
  _testSdk = undefined;
  _testSdkSet = false;
  _xrayCache = undefined;
}

/**
 * Annotate the current X-Ray segment with the correlation ID and any
 * additional fields provided.
 *
 * Annotations are indexed and searchable in the X-Ray service map / trace
 * list. Field values must be string, number, or boolean.
 *
 * No-ops silently when:
 *   • aws-xray-sdk-core is not installed.
 *   • No active segment exists (not running under X-Ray daemon).
 *   • Any other unexpected error from the SDK.
 *
 * @param correlationId  The correlation ID to annotate on the segment.
 * @param fields         Optional additional key/value annotations.
 */
export function annotateTrace(
  correlationId: string,
  fields?: Record<string, string | number | boolean>,
): void {
  try {
    const xray = tryLoadXRay();
    if (xray === null) return;

    let segment: XRaySegmentLike | null | undefined;
    try {
      segment = xray.resolveSegment();
    } catch {
      // resolveSegment throws when no segment is in context.
      segment = null;
    }
    if (segment == null) return;

    segment.addAnnotation("correlationId", correlationId);
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        segment.addAnnotation(key, value);
      }
    }
  } catch {
    // Never surface X-Ray errors to callers.
  }
}

/**
 * Add structured metadata to the current X-Ray segment under the given
 * namespace. Metadata is stored with the trace but not indexed for filtering.
 *
 * No-ops silently under the same conditions as `annotateTrace`.
 *
 * @param namespace  Metadata namespace (e.g. "logging", "request").
 * @param data       Arbitrary serialisable data to store.
 */
export function addTraceMetadata(
  namespace: string,
  data: Record<string, unknown>,
): void {
  try {
    const xray = tryLoadXRay();
    if (xray === null) return;

    let segment: XRaySegmentLike | null | undefined;
    try {
      segment = xray.resolveSegment();
    } catch {
      segment = null;
    }
    if (segment == null) return;

    segment.addMetadata(namespace, data);
  } catch {
    // Never surface X-Ray errors to callers.
  }
}
