/**
 * @bucket-broker/logging — public API.
 *
 * Quick-start
 * ───────────
 * ```typescript
 * import {
 *   Logger,
 *   adoptOrGenerate,
 *   injectCorrelationId,
 *   annotateTrace,
 * } from "@bucket-broker/logging";
 *
 * // At the top of a Lambda handler:
 * const correlationId = adoptOrGenerate({
 *   headers: event.headers,
 *   awsRequestId: context.awsRequestId,
 * });
 * const logger = new Logger({ service: "request-handler", layer: "lambda", correlationId });
 * logger.annotateTrace();           // bind to X-Ray segment (no-op if absent)
 *
 * logger.info("Request received", { path: event.path });
 * logger.error("Unexpected error", err);
 *
 * // Create a child for a sub-operation:
 * const childLogger = logger.child({ requestId: "abc123" });
 *
 * // Propagate to a downstream call:
 * const outHeaders: Record<string, string> = {};
 * injectCorrelationId(correlationId, { headers: outHeaders });
 * ```
 */

// Core types
export type { LogLevel, LogEntry, LoggerOptions, CorrelationIdSources } from "./types.js";

// Logger class
export { Logger } from "./logger.js";

// Correlation-ID helpers
export {
  generateCorrelationId,
  extractCorrelationId,
  adoptOrGenerate,
  injectCorrelationId,
} from "./correlation-id.js";

// Redaction helpers
export { DEFAULT_DENYLIST, normaliseKey, createDenylist, redact } from "./redact.js";

// X-Ray helpers
export { annotateTrace, addTraceMetadata } from "./xray.js";
