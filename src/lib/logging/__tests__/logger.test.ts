import { Logger } from "../src/logger";
import { LogEntry, LoggerOptions } from "../src/types";

/** UUID-v4 regex. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REDACTED = "[REDACTED]";

/**
 * Helper: create a Logger that captures output to an array.
 * `overrides` is merged into the default options, allowing any LoggerOption
 * to be customised per-test.
 */
function captureLogger(overrides: Partial<LoggerOptions> = {}): {
  logger: Logger;
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const logger = new Logger({
    service: "test-service",
    layer: "test-layer",
    output: (e) => entries.push(e),
    ...overrides,
  });
  return { logger, entries };
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe("Logger — construction", () => {
  it("generates a UUID-v4 correlationId when not provided", () => {
    const { logger } = captureLogger();
    expect(logger.getCorrelationId()).toMatch(UUID_V4_RE);
  });

  it("uses the provided correlationId", () => {
    const { logger } = captureLogger({ correlationId: "fixed-id" });
    expect(logger.getCorrelationId()).toBe("fixed-id");
  });

  it("different Logger instances get different correlationIds when not specified", () => {
    const { logger: a } = captureLogger();
    const { logger: b } = captureLogger();
    expect(a.getCorrelationId()).not.toBe(b.getCorrelationId());
  });
});

// ─── Log levels ───────────────────────────────────────────────────────────────

describe("Logger — log levels", () => {
  it("emits debug entry with level='debug'", () => {
    const { logger, entries } = captureLogger();
    logger.debug("debug msg");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("debug");
    expect(entries[0].message).toBe("debug msg");
  });

  it("emits info entry with level='info'", () => {
    const { logger, entries } = captureLogger();
    logger.info("info msg");
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toBe("info msg");
  });

  it("emits warn entry with level='warn'", () => {
    const { logger, entries } = captureLogger();
    logger.warn("warn msg");
    expect(entries[0].level).toBe("warn");
  });

  it("emits error entry with level='error'", () => {
    const { logger, entries } = captureLogger();
    logger.error("error msg");
    expect(entries[0].level).toBe("error");
  });
});

// ─── Stable schema fields ─────────────────────────────────────────────────────

describe("Logger — stable schema fields", () => {
  it("always includes timestamp, level, correlationId, message, service, layer", () => {
    const { logger, entries } = captureLogger();
    logger.info("test");
    const entry = entries[0];
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.level).toBe("info");
    expect(entry.correlationId).toBeDefined();
    expect(entry.message).toBe("test");
    expect(entry.service).toBe("test-service");
    expect(entry.layer).toBe("test-layer");
  });

  it("merges additional data fields into the log entry", () => {
    const { logger, entries } = captureLogger();
    logger.info("with data", { requestId: "req-1", path: "/buckets" });
    const entry = entries[0];
    expect(entry["requestId"]).toBe("req-1");
    expect(entry["path"]).toBe("/buckets");
  });

  it("output is valid JSON (parseable string)", () => {
    const lines: string[] = [];
    const logger = new Logger({
      service: "svc",
      layer: "lyr",
      output: (e) => lines.push(JSON.stringify(e)),
    });
    logger.info("test");
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed["level"]).toBe("info");
    expect(typeof parsed["timestamp"]).toBe("string");
    expect(typeof parsed["correlationId"]).toBe("string");
  });
});

// ─── Error method ─────────────────────────────────────────────────────────────

describe("Logger — error method", () => {
  it("includes errorType, errorMessage, stack from Error object", () => {
    const { logger, entries } = captureLogger();
    const err = new TypeError("something went wrong");
    logger.error("caught error", err);
    const entry = entries[0];
    expect(entry.errorType).toBe("TypeError");
    expect(entry.errorMessage).toBe("something went wrong");
    expect(entry.stack).toContain("TypeError");
  });

  it("emits error entry without Error object (no errorType or errorMessage)", () => {
    const { logger, entries } = captureLogger();
    logger.error("bare error");
    expect(entries[0].level).toBe("error");
    expect(entries[0].errorType).toBeUndefined();
    expect(entries[0].errorMessage).toBeUndefined();
  });

  it("merges extra data fields alongside error info", () => {
    const { logger, entries } = captureLogger();
    logger.error("err with data", new Error("boom"), { correlationRef: "ref-99" });
    expect(entries[0]["correlationRef"]).toBe("ref-99");
    expect(entries[0].errorMessage).toBe("boom");
  });

  it("custom Error subclass uses constructor name as errorType", () => {
    class ValidationError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
      }
    }
    const { logger, entries } = captureLogger();
    logger.error("validation failed", new ValidationError("bad input"));
    expect(entries[0].errorType).toBe("ValidationError");
  });
});

// ─── Context fields ───────────────────────────────────────────────────────────

describe("Logger — context fields", () => {
  it("merges constructor context into every log entry", () => {
    const { logger, entries } = captureLogger({
      context: { requestId: "ctx-req", env: "test" },
    });
    logger.info("msg");
    expect(entries[0]["requestId"]).toBe("ctx-req");
    expect(entries[0]["env"]).toBe("test");
  });

  it("additional data in a log call overrides context for same key", () => {
    const { logger, entries } = captureLogger({ context: { key: "from-context" } });
    logger.info("msg", { key: "from-data" });
    expect(entries[0]["key"]).toBe("from-data");
  });

  it("context fields appear in every subsequent log call", () => {
    const { logger, entries } = captureLogger({ context: { trace: "t1" } });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(entries.every((e) => e["trace"] === "t1")).toBe(true);
  });
});

// ─── Child logger ─────────────────────────────────────────────────────────────

describe("Logger — child logger", () => {
  it("inherits correlationId from parent", () => {
    const entries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      correlationId: "parent-corr",
      output: (e) => entries.push(e),
    });
    const child = parent.child({ component: "child-cmp" });
    expect(child.getCorrelationId()).toBe("parent-corr");
    child.info("child log");
    expect(entries[0].correlationId).toBe("parent-corr");
  });

  it("inherits parent context and merges new context", () => {
    const entries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      context: { parentField: "p" },
      output: (e) => entries.push(e),
    });
    const child = parent.child({ childField: "c" });
    child.info("msg");
    expect(entries[0]["parentField"]).toBe("p");
    expect(entries[0]["childField"]).toBe("c");
  });

  it("accepts an explicit correlationId override", () => {
    const entries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      correlationId: "orig-id",
      output: (e) => entries.push(e),
    });
    const child = parent.child({}, "overridden-id");
    expect(child.getCorrelationId()).toBe("overridden-id");
    child.info("msg");
    expect(entries[0].correlationId).toBe("overridden-id");
  });

  it("grandchild inherits correlationId through chain", () => {
    const entries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      correlationId: "chain-id",
      output: (e) => entries.push(e),
    });
    const child = parent.child({ step: "1" });
    const grandchild = child.child({ step: "2" });
    grandchild.info("deep");
    expect(entries[0].correlationId).toBe("chain-id");
    expect(entries[0]["step"]).toBe("2");
  });

  it("child does not bleed context back to parent", () => {
    const parentEntries: LogEntry[] = [];
    const childEntries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      output: (e) => parentEntries.push(e),
    });
    const child = parent.child({ childOnly: "yes" }, undefined);
    // Override output for child (not possible without a separate factory — so
    // we just verify parent entries lack childOnly)
    void child; // verify no error
    parent.info("parent msg");
    expect(parentEntries[0]["childOnly"]).toBeUndefined();
    void childEntries; // unused in this test
  });
});

// ─── Redaction ────────────────────────────────────────────────────────────────

describe("Logger — redaction", () => {
  it("redacts default denylist fields in log data", () => {
    const { logger, entries } = captureLogger();
    logger.info("auth event", { authorization: "Bearer secret-token" });
    expect(entries[0]["authorization"]).toBe(REDACTED);
  });

  it("redacts password in log data", () => {
    const { logger, entries } = captureLogger();
    logger.info("login", { username: "alice", password: "hunter2" });
    expect(entries[0]["password"]).toBe(REDACTED);
    expect(entries[0]["username"]).toBe("alice");
  });

  it("redacts nested sensitive fields in log data", () => {
    const { logger, entries } = captureLogger();
    logger.info("user data", { user: { name: "Bob", token: "tok-secret" } });
    const user = entries[0]["user"] as Record<string, unknown>;
    expect(user["token"]).toBe(REDACTED);
    expect(user["name"]).toBe("Bob");
  });

  it("redacts JWT token field", () => {
    const { logger, entries } = captureLogger();
    logger.info("auth", { jwt: "eyJhbGci..." });
    expect(entries[0]["jwt"]).toBe(REDACTED);
  });

  it("redacts custom denylist fields", () => {
    const { logger, entries } = captureLogger({ redactDenylist: ["internalRef"] });
    logger.info("msg", { internalRef: "ref-abc", safe: "visible" });
    expect(entries[0]["internalRef"]).toBe(REDACTED);
    expect(entries[0]["safe"]).toBe("visible");
  });

  it("child inherits custom denylist from parent", () => {
    const entries: LogEntry[] = [];
    const parent = new Logger({
      service: "svc",
      layer: "lyr",
      redactDenylist: ["mySecret"],
      output: (e) => entries.push(e),
    });
    const child = parent.child({ step: "child" });
    child.info("msg", { mySecret: "dont-log-this" });
    expect(entries[0]["mySecret"]).toBe(REDACTED);
  });

  it("correlationId itself is never redacted (not in denylist)", () => {
    const { logger, entries } = captureLogger({ correlationId: "corr-id-safe" });
    logger.info("msg");
    expect(entries[0].correlationId).toBe("corr-id-safe");
  });

  it("stable schema fields (level, service, layer, message) are not redacted", () => {
    const { logger, entries } = captureLogger({ correlationId: "cid" });
    logger.info("hello");
    expect(entries[0].level).toBe("info");
    expect(entries[0].service).toBe("test-service");
    expect(entries[0].layer).toBe("test-layer");
    expect(entries[0].message).toBe("hello");
  });
});

// ─── Reserved-field collision protection ──────────────────────────────────────

describe("Logger — reserved-field collision protection", () => {
  it("'level' in data cannot overwrite the stable level field", () => {
    const { logger, entries } = captureLogger();
    logger.info("test msg", { level: "debug" });
    // The emitted level must reflect the actual call (info), not the data field.
    expect(entries[0].level).toBe("info");
  });

  it("'correlationId' in data cannot overwrite the stable correlationId", () => {
    const { logger, entries } = captureLogger({ correlationId: "real-id" });
    logger.info("test msg", { correlationId: "injected-id" });
    expect(entries[0].correlationId).toBe("real-id");
  });

  it("'service' in data cannot overwrite the stable service field", () => {
    const { logger, entries } = captureLogger();
    logger.info("test msg", { service: "attacker" });
    expect(entries[0].service).toBe("test-service");
  });

  it("'layer' in data cannot overwrite the stable layer field", () => {
    const { logger, entries } = captureLogger();
    logger.info("test msg", { layer: "injected-layer" });
    expect(entries[0].layer).toBe("test-layer");
  });

  it("'message' in data cannot overwrite the stable message field", () => {
    const { logger, entries } = captureLogger();
    logger.info("real message", { message: "injected message" });
    expect(entries[0].message).toBe("real message");
  });

  it("'timestamp' in data cannot overwrite the stable timestamp field", () => {
    const { logger, entries } = captureLogger();
    const before = new Date().toISOString();
    logger.info("test msg", { timestamp: "1970-01-01T00:00:00.000Z" });
    const after = new Date().toISOString();
    // The emitted timestamp must be in the valid range, not the injected one.
    expect(entries[0].timestamp >= before).toBe(true);
    expect(entries[0].timestamp <= after).toBe(true);
  });

  it("'correlationId' in context cannot overwrite the stable correlationId", () => {
    const { logger, entries } = captureLogger({
      correlationId: "real-id",
      context: { correlationId: "context-injected" },
    });
    logger.info("test msg");
    expect(entries[0].correlationId).toBe("real-id");
  });
});

// ─── Non-Error thrown values in error() ───────────────────────────────────────

describe("Logger — non-Error values in error()", () => {
  it("accepts a string error without throwing", () => {
    const { logger, entries } = captureLogger();
    expect(() => logger.error("caught string", "oops")).not.toThrow();
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toBe("caught string");
  });

  it("records errorType='string' and errorMessage for a string error", () => {
    const { logger, entries } = captureLogger();
    logger.error("string error", "something broke");
    expect(entries[0]["errorType"]).toBe("string");
    expect(entries[0]["errorMessage"]).toBe("something broke");
  });

  it("accepts a plain object error without throwing", () => {
    const { logger, entries } = captureLogger();
    expect(() => logger.error("caught object", { code: 42 })).not.toThrow();
    expect(entries[0].level).toBe("error");
  });

  it("records errorType='object' for a plain object error", () => {
    const { logger, entries } = captureLogger();
    logger.error("object error", { code: 42 });
    expect(entries[0]["errorType"]).toBe("object");
  });

  it("accepts null error without throwing", () => {
    const { logger, entries } = captureLogger();
    expect(() => logger.error("null error", null)).not.toThrow();
    expect(entries[0].level).toBe("error");
  });

  it("records errorType='object' and errorMessage='null' for null error", () => {
    const { logger, entries } = captureLogger();
    logger.error("null error", null);
    // typeof null === "object" is a well-known JS quirk
    expect(entries[0]["errorType"]).toBe("object");
    expect(entries[0]["errorMessage"]).toBe("null");
  });

  it("accepts a number error without throwing", () => {
    const { logger, entries } = captureLogger();
    expect(() => logger.error("number error", 404)).not.toThrow();
    expect(entries[0]["errorType"]).toBe("number");
    expect(entries[0]["errorMessage"]).toBe("404");
  });
});
