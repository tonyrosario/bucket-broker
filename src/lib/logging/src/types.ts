/**
 * Structured log schema for @bucket-broker/logging.
 *
 * All log entries emitted by this library are JSON objects conforming to
 * LogEntry. CloudWatch metric filters should key on the stable field names
 * listed here — do not parse free-form text.
 *
 * Stable schema fields
 * ────────────────────
 * level          "debug" | "info" | "warn" | "error"
 * timestamp      ISO-8601 UTC string (e.g. "2026-07-05T12:34:56.789Z")
 * correlationId  UUID-v4 string; generated if not supplied; propagated through
 *                every layer (web → API → authorizer → handler → Step
 *                Functions → CodeBuild) via the x-correlation-id HTTP header
 *                and the correlationId event/payload field.
 * message        Human-readable summary string.
 * service        Logical service name (e.g. "request-handler", "authorizer").
 * layer          Runtime layer (e.g. "lambda", "step-functions", "codebuild",
 *                "api-gateway", "web").
 * errorType      (error logs only) Error constructor name (e.g. "TypeError").
 * errorMessage   (error logs only) Error.message value.
 * stack          (error logs only) Error.stack string.
 *
 * All additional key/value context passed to log methods is merged into the
 * top-level object, redacted, and emitted alongside these stable fields.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured log entry — every emission is JSON-serialisable. */
export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  correlationId: string;
  message: string;
  service: string;
  layer: string;
  errorType?: string;
  errorMessage?: string;
  stack?: string;
  [key: string]: unknown;
}

/** Options for constructing a Logger instance. */
export interface LoggerOptions {
  /** Logical service name. Appears in every log entry. */
  service: string;
  /** Runtime layer name. Appears in every log entry. */
  layer: string;
  /**
   * Correlation ID to bind to this logger. If omitted a new UUID-v4 is
   * generated automatically.
   */
  correlationId?: string;
  /** Additional key/value pairs merged into every log entry. */
  context?: Record<string, unknown>;
  /**
   * Extra keys to redact on top of the built-in denylist. Values that
   * normalise to any entry in this list (lower-cased, hyphens/underscores
   * stripped) are replaced with "[REDACTED]" in the output.
   */
  redactDenylist?: string[];
  /**
   * Override the output sink. Defaults to writing a single JSON line to
   * process.stdout. Useful for tests and custom CloudWatch adapters.
   */
  output?: (entry: LogEntry) => void;
}

/**
 * Sources from which an incoming correlation-id can be extracted.
 * Pass whichever sources are available; extraction is tried in priority order:
 *   1. HTTP headers (x-correlation-id, case-insensitive)
 *   2. Event payload field "correlationId"
 *   3. Lambda context awsRequestId (fallback)
 */
export interface CorrelationIdSources {
  /** HTTP request headers (case-insensitive key lookup). */
  headers?: Record<string, string | undefined>;
  /** Arbitrary event/payload object that may carry a correlationId field. */
  event?: Record<string, unknown>;
  /**
   * Lambda context.awsRequestId — used as a last-resort fallback so every
   * Lambda invocation gets a traceable id even when callers don't propagate
   * one.
   */
  awsRequestId?: string;
}
