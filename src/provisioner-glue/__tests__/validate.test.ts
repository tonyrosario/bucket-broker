import { validateRequest, ValidationError } from "../src/validate";
import type { ProvisionRequest } from "../src/types";

const PREFIX = "bucketbroker";

function goodRequest(overrides: Partial<ProvisionRequest> = {}): Partial<ProvisionRequest> {
  return {
    requestId: "11111111-2222-3333-4444-555555555555",
    correlationId: "corr-abc-123",
    bucketName: "bucketbroker-platform-data",
    team: "platform",
    owner: "platform@acme.example.com",
    costCenter: "CC-1234",
    path: "golden",
    ...overrides,
  };
}

describe("validateRequest", () => {
  it("accepts a well-formed golden request and defaults path", () => {
    const { path, ...rest } = goodRequest();
    void path;
    const out = validateRequest(rest as Partial<ProvisionRequest>, PREFIX);
    expect(out.path).toBe("golden");
    expect(out.bucketName).toBe("bucketbroker-platform-data");
  });

  it("accepts the escape path explicitly", () => {
    expect(validateRequest(goodRequest({ path: "escape" }), PREFIX).path).toBe("escape");
  });

  it.each([
    ["bucketName with quotes", { bucketName: 'bucketbroker-a"evil' }],
    ["bucketName with HCL interpolation", { bucketName: "bucketbroker-${var.x}" }],
    ["bucketName with shell metachars", { bucketName: "bucketbroker-a;rm -rf" }],
    ["bucketName uppercase", { bucketName: "bucketbroker-Data" }],
    ["bucketName underscore", { bucketName: "bucketbroker_data" }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateRequest(goodRequest(override), PREFIX)).toThrow(ValidationError);
  });

  it("rejects a bucket name outside the platform prefix", () => {
    expect(() => validateRequest(goodRequest({ bucketName: "victim-bucket-name" }), PREFIX)).toThrow(
      /must start with the platform prefix/,
    );
  });

  it.each([
    ["team", { team: "bad team!" }],
    ["owner", { owner: "not a valid owner!!" }],
    ["costCenter", { costCenter: "CC 1234$" }],
    ["requestId", { requestId: "id with spaces" }],
    ["path", { path: "public" as unknown as "golden" }],
  ])("rejects invalid %s", (_field, override) => {
    expect(() => validateRequest(goodRequest(override), PREFIX)).toThrow(ValidationError);
  });

  it("rejects missing required fields", () => {
    expect(() => validateRequest({ requestId: "x" } as Partial<ProvisionRequest>, PREFIX)).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-object request", () => {
    expect(() => validateRequest(null, PREFIX)).toThrow(ValidationError);
    expect(() => validateRequest(undefined, PREFIX)).toThrow(ValidationError);
  });

  it("surfaces the offending field on the error", () => {
    try {
      validateRequest(goodRequest({ team: "" }), PREFIX);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe("team");
    }
  });
});
