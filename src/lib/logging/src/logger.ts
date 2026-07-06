/**
 * Structured logger for @bucket-broker/logging.
 *
 * Each Logger instance is bound to:
 *   • service + layer  — stable identifiers for CloudWatch metric filters
 *   • correlationId    — UUID-v4 propagated through every platform layer
 *   • context          — arbitrary key/value fields merged into every entry
 *   • denylist         — sensitive-field names that are redacted before output
 *
 * Child loggers
 * ──────────────
 * Call `logger.child(context)` to create a derived logger that inherits the
 * correlationId, service, layer, denylist, and parent context, with additional
 * context fields merged in. All descendants share the same correlation ID
 * unless an explicit override is passed.
 *
 * Output
 * ───────
 * Each log call emits exactly one JSON line to process.stdout (or the custom
 * `output` function provided in LoggerOptions). The emitted object always
 * includes the stable schema fields documented in types.ts.
 *
 * X-Ray
 * ──────
 * `logger.annotateTrace(fields?)` annotates the current X-Ray segment (if
 * any) with the correlationId and optional extra fields. This is a no-op when
 * not running under X-Ray.
 */

import { LogEntry, LoggerOptions, LogLevel } from "./types.js";
import { generateCorrelationId } from "./correlation-id.js";
import { createDenylist, redact } from "./redact.js";
import { annotateTrace } from "./xray.js";

function defaultOutput(entry: LogEntry): void {
  try {
    process.stdout.write(JSON.stringify(entry) + "\n");
  } catch {
    // Fallback for non-serialisable values (e.g. a BigInt that slipped
    // through redact, or some other exotic type).  Emit the six stable
    // schema fields so the log line is still parseable.
    const safe = {
      level: entry.level,
      timestamp: entry.timestamp,
      correlationId: entry.correlationId,
      message: entry.message,
      service: entry.service,
      layer: entry.layer,
      _serialisationError: "log entry contained a non-JSON-serialisable value",
    };
    process.stdout.write(JSON.stringify(safe) + "\n");
  }
}

export class Logger {
  private readonly service: string;
  private readonly layer: string;
  private readonly correlationId: string;
  private readonly context: Record<string, unknown>;
  private readonly denylist: Set<string>;
  private readonly customDenylist: ReadonlyArray<string>;
  private readonly outputFn: (entry: LogEntry) => void;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.layer = options.layer;
    this.correlationId = options.correlationId ?? generateCorrelationId();
    this.context = options.context ?? {};
    this.customDenylist = options.redactDenylist ?? [];
    this.denylist = createDenylist(this.customDenylist);
    this.outputFn = options.output ?? defaultOutput;
  }

  /** Return the correlation ID bound to this logger. */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Create a child logger that inherits correlationId, service, layer,
   * denylist, and parent context. Additional context fields are merged in.
   *
   * @param context        Extra key/value fields to merge into every log entry.
   * @param correlationId  Override the inherited correlation ID (rare — use
   *                       only when deliberately starting a new trace, e.g.
   *                       at the boundary of an async sub-workflow).
   */
  child(context: Record<string, unknown>, correlationId?: string): Logger {
    return new Logger({
      service: this.service,
      layer: this.layer,
      correlationId: correlationId ?? this.correlationId,
      context: { ...this.context, ...context },
      redactDenylist: [...this.customDenylist],
      output: this.outputFn,
    });
  }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const raw: LogEntry = {
      // Merge context and call-site data first so the stable schema fields
      // declared below always win and cannot be overwritten by callers.
      // This guarantees CloudWatch metric filters keyed on level / service /
      // correlationId / etc. are never corrupted by user-supplied data.
      ...this.context,
      ...data,
      // Stable schema fields — always declared last; always present and correct.
      level,
      timestamp: new Date().toISOString(),
      correlationId: this.correlationId,
      message,
      service: this.service,
      layer: this.layer,
    };
    const redacted = redact(raw, this.denylist) as LogEntry;
    this.outputFn(redacted);
  }

  /** Emit a DEBUG-level structured log entry. */
  debug(message: string, data?: Record<string, unknown>): void {
    this.emit("debug", message, data);
  }

  /** Emit an INFO-level structured log entry. */
  info(message: string, data?: Record<string, unknown>): void {
    this.emit("info", message, data);
  }

  /** Emit a WARN-level structured log entry. */
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit("warn", message, data);
  }

  /**
   * Emit an ERROR-level structured log entry.
   *
   * When an `Error` object is provided its constructor name, message, and
   * stack are added to the entry as `errorType`, `errorMessage`, and `stack`.
   * When any other value is thrown (TypeScript `catch` blocks yield `unknown`),
   * `errorType` is set to `typeof error` and `errorMessage` to `String(error)`.
   *
   * These stable names allow CloudWatch metric filters such as:
   *   `{ $.level = "error" && $.service = "request-handler" }`
   *
   * @param error  The caught value — may be an `Error`, a string, an object,
   *               `null`, or any other value a `catch` block can produce.
   */
  error(message: string, error?: unknown, data?: Record<string, unknown>): void {
    const errorFields: Record<string, unknown> = {};
    if (error !== undefined) {
      if (error instanceof Error) {
        errorFields["errorType"] = error.constructor.name;
        errorFields["errorMessage"] = error.message;
        errorFields["stack"] = error.stack;
      } else {
        // Handle non-Error thrown values (strings, plain objects, null, etc.)
        errorFields["errorType"] = typeof error;
        errorFields["errorMessage"] = String(error);
      }
    }
    this.emit("error", message, { ...errorFields, ...data });
  }

  /**
   * Annotate the current X-Ray segment (if any) with the correlationId and
   * optional additional fields. No-ops when not running under X-Ray.
   *
   * Call once per Lambda handler after creating the logger to bind the
   * correlation ID to the X-Ray trace.
   */
  annotateTrace(fields?: Record<string, string | number | boolean>): void {
    annotateTrace(this.correlationId, {
      service: this.service,
      layer: this.layer,
      ...fields,
    });
  }
}
