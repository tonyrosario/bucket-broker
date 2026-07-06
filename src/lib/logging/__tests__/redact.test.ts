import {
  DEFAULT_DENYLIST,
  normaliseKey,
  createDenylist,
  redact,
} from "../src/redact";

const REDACTED = "[REDACTED]";

describe("normaliseKey", () => {
  it("lower-cases input", () => {
    expect(normaliseKey("Authorization")).toBe("authorization");
  });

  it("strips hyphens", () => {
    expect(normaliseKey("x-api-key")).toBe("xapikey");
  });

  it("strips underscores", () => {
    expect(normaliseKey("access_token")).toBe("accesstoken");
  });

  it("strips spaces", () => {
    expect(normaliseKey("api key")).toBe("apikey");
  });

  it("handles mixed separators", () => {
    expect(normaliseKey("X-API_Key")).toBe("xapikey");
  });
});

describe("DEFAULT_DENYLIST", () => {
  it("is non-empty", () => {
    expect(DEFAULT_DENYLIST.length).toBeGreaterThan(0);
  });

  it("includes common auth/token fields", () => {
    expect(DEFAULT_DENYLIST).toContain("authorization");
    expect(DEFAULT_DENYLIST).toContain("token");
    expect(DEFAULT_DENYLIST).toContain("bearer");
    expect(DEFAULT_DENYLIST).toContain("jwt");
    expect(DEFAULT_DENYLIST).toContain("password");
    expect(DEFAULT_DENYLIST).toContain("secret");
    expect(DEFAULT_DENYLIST).toContain("apikey");
  });

  it("includes PII/payment fields", () => {
    expect(DEFAULT_DENYLIST).toContain("ssn");
    expect(DEFAULT_DENYLIST).toContain("pan");
    expect(DEFAULT_DENYLIST).toContain("cvv");
  });
});

describe("createDenylist", () => {
  it("includes all DEFAULT_DENYLIST entries normalised", () => {
    const dl = createDenylist();
    for (const entry of DEFAULT_DENYLIST) {
      expect(dl.has(normaliseKey(entry))).toBe(true);
    }
  });

  it("appends custom entries", () => {
    const dl = createDenylist(["myCustomSecret"]);
    expect(dl.has("mycustomsecret")).toBe(true);
  });

  it("normalises custom entries (hyphens, case)", () => {
    const dl = createDenylist(["My-Custom-Key"]);
    expect(dl.has("mycustomkey")).toBe(true);
  });
});

describe("redact — scalars pass through", () => {
  const dl = createDenylist();

  it("returns strings unchanged", () => {
    expect(redact("hello", dl)).toBe("hello");
  });

  it("returns numbers unchanged", () => {
    expect(redact(42, dl)).toBe(42);
  });

  it("returns booleans unchanged", () => {
    expect(redact(true, dl)).toBe(true);
  });

  it("returns null unchanged", () => {
    expect(redact(null, dl)).toBeNull();
  });
});

describe("redact — top-level sensitive fields", () => {
  const dl = createDenylist();

  it("redacts 'password' field", () => {
    const result = redact({ password: "hunter2" }, dl) as Record<string, unknown>;
    expect(result["password"]).toBe(REDACTED);
  });

  it("redacts 'authorization' field", () => {
    const result = redact({ authorization: "Bearer tok" }, dl) as Record<string, unknown>;
    expect(result["authorization"]).toBe(REDACTED);
  });

  it("redacts 'token' field", () => {
    const result = redact({ token: "abc.def.ghi" }, dl) as Record<string, unknown>;
    expect(result["token"]).toBe(REDACTED);
  });

  it("redacts 'secret' field", () => {
    const result = redact({ secret: "s3cr3t" }, dl) as Record<string, unknown>;
    expect(result["secret"]).toBe(REDACTED);
  });

  it("redacts 'apikey' field (normalised match)", () => {
    // key name uses underscore — should still match the 'apikey' denylist entry
    const result = redact({ api_key: "key-val" }, dl) as Record<string, unknown>;
    expect(result["api_key"]).toBe(REDACTED);
  });

  it("redacts 'Authorization' (mixed case field name)", () => {
    const result = redact({ Authorization: "Bearer tok" }, dl) as Record<string, unknown>;
    expect(result["Authorization"]).toBe(REDACTED);
  });

  it("preserves non-sensitive fields", () => {
    const result = redact({ userId: "u-123", message: "hello" }, dl) as Record<string, unknown>;
    expect(result["userId"]).toBe("u-123");
    expect(result["message"]).toBe("hello");
  });
});

describe("redact — recursive / nested objects", () => {
  const dl = createDenylist();

  it("redacts sensitive fields in a nested object", () => {
    const input = {
      user: {
        name: "Alice",
        password: "secret123",
      },
    };
    const result = redact(input, dl) as { user: Record<string, unknown> };
    expect(result.user["name"]).toBe("Alice");
    expect(result.user["password"]).toBe(REDACTED);
  });

  it("redacts sensitive fields at multiple nesting depths", () => {
    const input = {
      level1: {
        level2: {
          token: "deep-secret",
          safe: "visible",
        },
      },
    };
    const result = redact(input, dl) as {
      level1: { level2: Record<string, unknown> };
    };
    expect(result.level1.level2["token"]).toBe(REDACTED);
    expect(result.level1.level2["safe"]).toBe("visible");
  });

  it("redacts sensitive fields inside arrays of objects", () => {
    const input = {
      users: [
        { name: "Alice", password: "pw1" },
        { name: "Bob",   password: "pw2" },
      ],
    };
    const result = redact(input, dl) as { users: Record<string, unknown>[] };
    expect(result.users[0]["password"]).toBe(REDACTED);
    expect(result.users[1]["password"]).toBe(REDACTED);
    expect(result.users[0]["name"]).toBe("Alice");
  });

  it("handles arrays of scalars without modification", () => {
    const input = { tags: ["a", "b", "c"] };
    const result = redact(input, dl) as { tags: string[] };
    expect(result.tags).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the original object", () => {
    const input = { password: "original", safe: "data" };
    redact(input, dl);
    expect(input.password).toBe("original");
  });
});

describe("redact — configurable denylist", () => {
  it("redacts a custom key not in the default denylist", () => {
    const dl = createDenylist(["internalTraceId"]);
    const result = redact({ internalTraceId: "trace-xyz" }, dl) as Record<string, unknown>;
    expect(result["internalTraceId"]).toBe(REDACTED);
  });

  it("custom key is matched case-insensitively", () => {
    const dl = createDenylist(["mySecret"]);
    const result = redact({ MySecret: "value" }, dl) as Record<string, unknown>;
    expect(result["MySecret"]).toBe(REDACTED);
  });

  it("custom key with hyphens matches field with underscores", () => {
    const dl = createDenylist(["my-token"]);
    const result = redact({ my_token: "value" }, dl) as Record<string, unknown>;
    expect(result["my_token"]).toBe(REDACTED);
  });

  it("default denylist entries are still active with custom entries", () => {
    const dl = createDenylist(["customField"]);
    const result = redact(
      { customField: "x", password: "y", safe: "z" },
      dl,
    ) as Record<string, unknown>;
    expect(result["customField"]).toBe(REDACTED);
    expect(result["password"]).toBe(REDACTED);
    expect(result["safe"]).toBe("z");
  });

  it("redacts custom key recursively in nested structure", () => {
    const dl = createDenylist(["accountNumber"]);
    const input = {
      outer: {
        inner: { accountNumber: "1234-5678" },
      },
    };
    const result = redact(input, dl) as {
      outer: { inner: Record<string, unknown> };
    };
    expect(result.outer.inner["accountNumber"]).toBe(REDACTED);
  });
});

describe("redact — LogEntry-shaped object (integration check)", () => {
  const dl = createDenylist();

  it("redacts sensitive fields from a realistic log entry", () => {
    const entry = {
      level: "info",
      timestamp: "2026-07-05T00:00:00.000Z",
      correlationId: "uuid-1234",
      message: "User authenticated",
      service: "authorizer",
      layer: "lambda",
      // Sensitive — should be redacted
      authorization: "Bearer eyJhbGciOi...",
      // Non-sensitive extras
      userId: "u-999",
      path: "/buckets",
    };
    const result = redact(entry, dl) as Record<string, unknown>;
    expect(result["authorization"]).toBe(REDACTED);
    expect(result["correlationId"]).toBe("uuid-1234");
    expect(result["userId"]).toBe("u-999");
    expect(result["level"]).toBe("info");
  });
});
