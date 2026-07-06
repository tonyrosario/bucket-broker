/**
 * Correlation-ID generation and propagation helpers.
 *
 * Design goals
 * ─────────────
 * • Zero runtime dependencies — uses Node.js 20's built-in crypto.randomUUID().
 * • Generation: produce a UUID-v4 when no incoming id is present.
 * • Adoption: extract an id from HTTP headers, event payloads, or Lambda
 *   context in priority order.
 * • Propagation: inject the id into outgoing headers/events so downstream
 *   layers can adopt it.
 *
 * Header convention: "x-correlation-id" (lower-case, canonical form).
 * Event convention:  "correlationId" (camelCase field on the payload object).
 */

import { randomUUID } from "crypto";
import { CorrelationIdSources } from "./types.js";

/** Generate a fresh UUID-v4 correlation ID. */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Extract an existing correlation ID from the provided sources.
 *
 * Priority order:
 *   1. HTTP header "x-correlation-id" (case-insensitive key match)
 *   2. Event payload field "correlationId" (string values only)
 *   3. awsRequestId (Lambda context fallback)
 *
 * Returns `undefined` when no id is found in any source.
 */
export function extractCorrelationId(sources: CorrelationIdSources): string | undefined {
  if (sources.headers) {
    // Normalise header keys to lower-case for case-insensitive lookup.
    const normalised: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(sources.headers)) {
      normalised[k.toLowerCase()] = v;
    }
    const id = normalised["x-correlation-id"];
    if (id !== undefined && id !== "") return id;
  }

  if (sources.event !== undefined) {
    const id = sources.event["correlationId"];
    if (typeof id === "string" && id !== "") return id;
  }

  if (sources.awsRequestId !== undefined && sources.awsRequestId !== "") {
    return sources.awsRequestId;
  }

  return undefined;
}

/**
 * Adopt an existing correlation ID from the provided sources, or generate a
 * new UUID-v4 if none is found. This is the primary entry point for Lambdas
 * and API handlers at the top of each request.
 *
 * @example
 * ```typescript
 * const correlationId = adoptOrGenerate({
 *   headers: event.headers,
 *   event: event.body,
 *   awsRequestId: context.awsRequestId,
 * });
 * const logger = new Logger({ service: "authorizer", layer: "lambda", correlationId });
 * ```
 */
export function adoptOrGenerate(sources: CorrelationIdSources): string {
  return extractCorrelationId(sources) ?? generateCorrelationId();
}

/**
 * Inject a correlation ID into outgoing headers and/or event objects so
 * downstream services can adopt it.
 *
 * Modifies both targets **in-place** (if provided) and returns the id for
 * convenience.
 *
 * @example
 * ```typescript
 * const outHeaders: Record<string, string> = {};
 * injectCorrelationId(correlationId, { headers: outHeaders });
 * // outHeaders["x-correlation-id"] === correlationId
 * ```
 */
export function injectCorrelationId(
  id: string,
  target: {
    headers?: Record<string, string>;
    event?: Record<string, unknown>;
  },
): string {
  if (target.headers !== undefined) {
    target.headers["x-correlation-id"] = id;
  }
  if (target.event !== undefined) {
    target.event["correlationId"] = id;
  }
  return id;
}
