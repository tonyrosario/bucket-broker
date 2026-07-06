import { buildTfvars, renderTfvarsJson, stateKeyFor } from "../src/render-tfvars";
import type { ValidatedRequest } from "../src/validate";

const req: ValidatedRequest = {
  requestId: "11111111-2222-3333-4444-555555555555",
  correlationId: "corr-1",
  bucketName: "bucketbroker-platform-data",
  team: "platform",
  owner: "platform@acme.example.com",
  costCenter: "CC-1234",
  path: "golden",
};

const brokers = ["arn:aws:iam::123456789012:role/bucket-broker-request-handler"];
const BOUNDARY = "arn:aws:iam::123456789012:policy/bb-test-team-role-boundary";

describe("renderTfvarsJson", () => {
  it("produces the exact golden-bucket variable set", () => {
    const out = JSON.parse(renderTfvarsJson(req, brokers, BOUNDARY)) as Record<string, unknown>;
    expect(out).toEqual({
      bucket_name: "bucketbroker-platform-data",
      team: "platform",
      owner: "platform@acme.example.com",
      cost_center: "CC-1234",
      path: "golden",
      trusted_principals: brokers,
      team_role_permissions_boundary_arn: BOUNDARY,
    });
  });

  it("output is valid JSON that Terraform's *.auto.tfvars.json loader can parse", () => {
    expect(() => {
      JSON.parse(renderTfvarsJson(req, brokers, BOUNDARY));
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // INJECTION-SAFETY (AC): even if a malicious value reached the renderer
  // (bypassing validation), JSON.stringify escapes every HCL metacharacter so
  // the value cannot break out of its JSON string or inject a new HCL
  // variable/token. There is no HCL string concatenation anywhere.
  // -----------------------------------------------------------------------
  it("cannot break out of the tfvars document via quotes / HCL / newlines", () => {
    const malicious: ValidatedRequest = {
      ...req,
      // A payload that WOULD escape an HCL string if concatenated:
      //   ..."\n} \n variable "backdoor" { default = "owned"
      owner: 'evil"\n}\nvariable "backdoor" {\n default = "owned"\n}\n#${path.module}',
    };

    const json = renderTfvarsJson(malicious, brokers, BOUNDARY);

    // The rendered text must not contain a raw (unescaped) closing-then-reopening
    // sequence — the quote before the newline is JSON-escaped as \".
    expect(json).toContain('\\"');
    expect(json).not.toContain('owner":"evil"\n}');

    // Round-trips losslessly to exactly ONE field with the literal payload; no
    // "backdoor" key is introduced.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["owner"]).toBe(malicious.owner);
    expect(parsed).not.toHaveProperty("backdoor");
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "bucket_name",
        "cost_center",
        "owner",
        "path",
        "team",
        "trusted_principals",
        "team_role_permissions_boundary_arn",
      ].sort(),
    );
  });

  it("escapes a bucket_name containing a double quote", () => {
    const malicious: ValidatedRequest = { ...req, bucketName: 'a"; evil = "x' };
    const parsed = JSON.parse(renderTfvarsJson(malicious, brokers, BOUNDARY)) as Record<string, unknown>;
    expect(parsed["bucket_name"]).toBe('a"; evil = "x');
    expect(parsed).not.toHaveProperty("evil");
  });
});

describe("buildTfvars", () => {
  it("passes broker principals through as trusted_principals (ADR-0006)", () => {
    expect(buildTfvars(req, brokers, BOUNDARY).trusted_principals).toEqual(brokers);
  });

  it("passes the permissions boundary through to the runner root", () => {
    expect(buildTfvars(req, brokers, BOUNDARY).team_role_permissions_boundary_arn).toBe(BOUNDARY);
  });
});

describe("stateKeyFor", () => {
  it("builds a per-request, isolated state key", () => {
    expect(stateKeyFor("provisioned", "req-9")).toBe("provisioned/req-9/terraform.tfstate");
  });
});
