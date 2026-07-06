import {
  generateCorrelationId,
  extractCorrelationId,
  adoptOrGenerate,
  injectCorrelationId,
} from "../src/correlation-id";

/** UUID-v4 regex for basic format validation. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateCorrelationId", () => {
  it("returns a UUID-v4 formatted string", () => {
    const id = generateCorrelationId();
    expect(id).toMatch(UUID_V4_RE);
  });

  it("returns a unique id on each call", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateCorrelationId()));
    expect(ids.size).toBe(20);
  });
});

describe("extractCorrelationId — HTTP headers", () => {
  it("extracts id from lower-case x-correlation-id header", () => {
    const id = extractCorrelationId({ headers: { "x-correlation-id": "abc-123" } });
    expect(id).toBe("abc-123");
  });

  it("extracts id from upper-case X-Correlation-Id header (case-insensitive)", () => {
    const id = extractCorrelationId({ headers: { "X-Correlation-Id": "XYZ-789" } });
    expect(id).toBe("XYZ-789");
  });

  it("extracts id from UPPER-CASE X-CORRELATION-ID header", () => {
    const id = extractCorrelationId({ headers: { "X-CORRELATION-ID": "upper-case" } });
    expect(id).toBe("upper-case");
  });

  it("returns undefined when x-correlation-id header is absent", () => {
    const id = extractCorrelationId({ headers: { "content-type": "application/json" } });
    expect(id).toBeUndefined();
  });

  it("returns undefined when x-correlation-id header is empty string", () => {
    const id = extractCorrelationId({ headers: { "x-correlation-id": "" } });
    expect(id).toBeUndefined();
  });
});

describe("extractCorrelationId — event payload", () => {
  it("extracts id from event.correlationId", () => {
    const id = extractCorrelationId({ event: { correlationId: "event-id-42" } });
    expect(id).toBe("event-id-42");
  });

  it("ignores event.correlationId when it is not a string", () => {
    const id = extractCorrelationId({ event: { correlationId: 12345 } });
    expect(id).toBeUndefined();
  });

  it("ignores event.correlationId when it is an empty string", () => {
    const id = extractCorrelationId({ event: { correlationId: "" } });
    expect(id).toBeUndefined();
  });

  it("ignores unrelated event fields", () => {
    const id = extractCorrelationId({ event: { requestId: "req-1", body: "{}" } });
    expect(id).toBeUndefined();
  });
});

describe("extractCorrelationId — awsRequestId fallback", () => {
  it("falls back to awsRequestId when headers and event have no id", () => {
    const id = extractCorrelationId({ awsRequestId: "aws-req-id-789" });
    expect(id).toBe("aws-req-id-789");
  });

  it("returns undefined when awsRequestId is empty string", () => {
    const id = extractCorrelationId({ awsRequestId: "" });
    expect(id).toBeUndefined();
  });
});

describe("extractCorrelationId — priority order", () => {
  it("prefers header over event correlationId", () => {
    const id = extractCorrelationId({
      headers: { "x-correlation-id": "from-header" },
      event: { correlationId: "from-event" },
      awsRequestId: "from-aws",
    });
    expect(id).toBe("from-header");
  });

  it("prefers event correlationId over awsRequestId", () => {
    const id = extractCorrelationId({
      event: { correlationId: "from-event" },
      awsRequestId: "from-aws",
    });
    expect(id).toBe("from-event");
  });

  it("returns undefined when all sources are absent", () => {
    const id = extractCorrelationId({});
    expect(id).toBeUndefined();
  });
});

describe("adoptOrGenerate", () => {
  it("adopts existing id from headers", () => {
    const id = adoptOrGenerate({ headers: { "x-correlation-id": "existing-id" } });
    expect(id).toBe("existing-id");
  });

  it("generates a new UUID-v4 when no id is found", () => {
    const id = adoptOrGenerate({});
    expect(id).toMatch(UUID_V4_RE);
  });

  it("generates a unique id on each call when no id is found", () => {
    const ids = new Set([adoptOrGenerate({}), adoptOrGenerate({}), adoptOrGenerate({})]);
    expect(ids.size).toBe(3);
  });

  it("end-to-end: adopts from header, skips generation", () => {
    const incomingId = generateCorrelationId();
    const adopted = adoptOrGenerate({ headers: { "x-correlation-id": incomingId } });
    expect(adopted).toBe(incomingId);
    // It must be the same — not a freshly generated one
    expect(adopted).toMatch(UUID_V4_RE);
  });
});

describe("injectCorrelationId", () => {
  it("injects into headers object", () => {
    const headers: Record<string, string> = {};
    injectCorrelationId("test-id", { headers });
    expect(headers["x-correlation-id"]).toBe("test-id");
  });

  it("injects into event object", () => {
    const event: Record<string, unknown> = {};
    injectCorrelationId("test-id", { event });
    expect(event["correlationId"]).toBe("test-id");
  });

  it("injects into both headers and event simultaneously", () => {
    const headers: Record<string, string> = {};
    const event: Record<string, unknown> = {};
    injectCorrelationId("dual-id", { headers, event });
    expect(headers["x-correlation-id"]).toBe("dual-id");
    expect(event["correlationId"]).toBe("dual-id");
  });

  it("returns the correlation id for convenience chaining", () => {
    const result = injectCorrelationId("chain-id", { headers: {} });
    expect(result).toBe("chain-id");
  });

  it("does not modify headers when headers is not provided", () => {
    const event: Record<string, unknown> = {};
    injectCorrelationId("no-headers-id", { event });
    expect(event["correlationId"]).toBe("no-headers-id");
    // No crash — no headers object was passed.
  });

  it("end-to-end propagation round-trip: inject then extract", () => {
    const original = generateCorrelationId();
    const headers: Record<string, string> = {};
    injectCorrelationId(original, { headers });

    // Downstream service extracts the id
    const extracted = extractCorrelationId({ headers });
    expect(extracted).toBe(original);
  });
});
