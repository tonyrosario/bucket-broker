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
    // "pan" removed — matches benign keys like "company", "expand", "panel"
    expect(DEFAULT_DENYLIST).toContain("cvv");
    expect(DEFAULT_DENYLIST).toContain("creditcard");
    expect(DEFAULT_DENYLIST).toContain("cardnumber");
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

// ─── Security: compound/prefixed sensitive keys MUST be redacted ─────────────

describe("redact — MUST redact (compound-key security coverage)", () => {
  const dl = createDenylist();

  it("redacts x-api-key (contains 'apikey' fragment)", () => {
    const result = redact({ "x-api-key": "key-abc" }, dl) as Record<string, unknown>;
    expect(result["x-api-key"]).toBe(REDACTED);
  });

  it("redacts client_secret (contains 'secret' fragment)", () => {
    const result = redact({ client_secret: "shh" }, dl) as Record<string, unknown>;
    expect(result["client_secret"]).toBe(REDACTED);
  });

  it("redacts dbSecret (contains 'secret' fragment)", () => {
    const result = redact({ dbSecret: "db-pass" }, dl) as Record<string, unknown>;
    expect(result["dbSecret"]).toBe(REDACTED);
  });

  it("redacts sessionToken (contains 'token' fragment)", () => {
    const result = redact({ sessionToken: "sess-tok" }, dl) as Record<string, unknown>;
    expect(result["sessionToken"]).toBe(REDACTED);
  });

  it("redacts x-amz-security-token (contains 'token' fragment)", () => {
    const result = redact({ "x-amz-security-token": "aws-tok" }, dl) as Record<string, unknown>;
    expect(result["x-amz-security-token"]).toBe(REDACTED);
  });

  it("redacts Set-Cookie (contains 'cookie' fragment)", () => {
    const result = redact({ "Set-Cookie": "session=abc; HttpOnly" }, dl) as Record<string, unknown>;
    expect(result["Set-Cookie"]).toBe(REDACTED);
  });

  it("redacts Cookie (contains 'cookie' fragment)", () => {
    const result = redact({ Cookie: "session=abc" }, dl) as Record<string, unknown>;
    expect(result["Cookie"]).toBe(REDACTED);
  });

  it("redacts userPassword (contains 'password' fragment)", () => {
    const result = redact({ userPassword: "hunter2" }, dl) as Record<string, unknown>;
    expect(result["userPassword"]).toBe(REDACTED);
  });

  it("redacts password nested inside a benign-named parent key", () => {
    const result = redact(
      { data: { password: "x" } },
      dl,
    ) as { data: Record<string, unknown> };
    expect(result.data["password"]).toBe(REDACTED);
    // The outer 'data' key is benign and must not be redacted
    expect(typeof result.data).toBe("object");
  });
});

// ─── No over-redaction: benign keys must pass through ─────────────────────────

describe("redact — MUST NOT redact (benign key no-over-redaction)", () => {
  const dl = createDenylist();

  it("does not redact 'author'", () => {
    const result = redact({ author: "Alice" }, dl) as Record<string, unknown>;
    expect(result["author"]).toBe("Alice");
  });

  it("does not redact 'authorId'", () => {
    const result = redact({ authorId: "u-1" }, dl) as Record<string, unknown>;
    expect(result["authorId"]).toBe("u-1");
  });

  it("does not redact 'description'", () => {
    const result = redact({ description: "A bucket for logs" }, dl) as Record<string, unknown>;
    expect(result["description"]).toBe("A bucket for logs");
  });

  it("does not redact 'timestamp'", () => {
    const result = redact(
      { timestamp: "2026-07-06T00:00:00.000Z" },
      dl,
    ) as Record<string, unknown>;
    expect(result["timestamp"]).toBe("2026-07-06T00:00:00.000Z");
  });

  it("does not redact 'shipping'", () => {
    const result = redact({ shipping: "express" }, dl) as Record<string, unknown>;
    expect(result["shipping"]).toBe("express");
  });

  it("does not redact 'count'", () => {
    const result = redact({ count: 42 }, dl) as Record<string, unknown>;
    expect(result["count"]).toBe(42);
  });

  it("does not redact 'region'", () => {
    const result = redact({ region: "us-east-1" }, dl) as Record<string, unknown>;
    expect(result["region"]).toBe("us-east-1");
  });

  it("does not redact 'service'", () => {
    const result = redact({ service: "my-service" }, dl) as Record<string, unknown>;
    expect(result["service"]).toBe("my-service");
  });

  it("does not redact 'spanId'", () => {
    const result = redact({ spanId: "sp-1" }, dl) as Record<string, unknown>;
    expect(result["spanId"]).toBe("sp-1");
  });
});

// ─── Robustness: circular references ─────────────────────────────────────────

describe("redact — circular reference safety", () => {
  const dl = createDenylist();

  it("does not throw on a self-referential object", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj["self"] = obj;
    expect(() => redact(obj, dl)).not.toThrow();
  });

  it("replaces the circular back-reference with '[Circular]'", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj["self"] = obj;
    const result = redact(obj, dl) as Record<string, unknown>;
    expect(result["name"]).toBe("test");
    expect(result["self"]).toBe("[Circular]");
  });

  it("handles indirect circular references (a → b → a)", () => {
    const a: Record<string, unknown> = { label: "a" };
    const b: Record<string, unknown> = { label: "b", parent: a };
    a["child"] = b;
    const result = redact(a, dl) as Record<string, unknown>;
    expect(result["label"]).toBe("a");
    expect((result["child"] as Record<string, unknown>)["label"]).toBe("b");
    // The back-reference to 'a' inside 'b' must be replaced, not recursed.
    expect((result["child"] as Record<string, unknown>)["parent"]).toBe("[Circular]");
  });
});

// ─── Robustness: BigInt values ────────────────────────────────────────────────

describe("redact — BigInt safety", () => {
  const dl = createDenylist();

  it("does not throw on a top-level BigInt value", () => {
    expect(() => redact(BigInt(42), dl)).not.toThrow();
  });

  it("converts a top-level BigInt to its decimal string", () => {
    expect(redact(BigInt(42), dl)).toBe("42");
  });

  it("converts a BigInt inside an object value to string", () => {
    const result = redact({ count: BigInt(999) }, dl) as Record<string, unknown>;
    expect(result["count"]).toBe("999");
  });

  it("converts BigInt inside an array element to string", () => {
    const result = redact({ ids: [BigInt(1), BigInt(2)] }, dl) as {
      ids: unknown[];
    };
    expect(result.ids[0]).toBe("1");
    expect(result.ids[1]).toBe("2");
  });
});
