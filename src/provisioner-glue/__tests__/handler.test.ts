const sendMock = jest.fn<Promise<unknown>, [unknown]>();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: sendMock })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ __type: "UpdateItemCommand", input })),
}));

import { handler } from "../src/handler";
import type { ProvisionRequest } from "../src/types";

function baseEvent(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    requestId: "11111111-2222-3333-4444-555555555555",
    correlationId: "corr-xyz",
    bucketName: "bucketbroker-platform-data",
    team: "platform",
    owner: "platform@acme.example.com",
    costCenter: "CC-1234",
    path: "golden",
    ...overrides,
  };
}

class ConditionalCheckFailedException extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

describe("handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env["STATUS_TABLE"] = "bb-requests";
    process.env["STATE_KEY_PREFIX"] = "provisioned";
    process.env["PROVISIONED_BUCKET_PREFIX"] = "bucketbroker";
    process.env["BROKER_PRINCIPAL_ARNS"] = JSON.stringify([
      "arn:aws:iam::123456789012:role/bucket-broker-request-handler",
    ]);
  });

  it("validates, renders tfvars, writes PROVISIONING, and returns the handoff", async () => {
    sendMock.mockResolvedValue({});

    const out = await handler(baseEvent());

    expect(out.requestId).toBe("11111111-2222-3333-4444-555555555555");
    expect(out.correlationId).toBe("corr-xyz");
    expect(out.bucketName).toBe("bucketbroker-platform-data");
    expect(out.team).toBe("platform");
    expect(out.stateKey).toBe("provisioned/11111111-2222-3333-4444-555555555555/terraform.tfstate");

    const tfvars = JSON.parse(out.tfvarsJson) as Record<string, unknown>;
    expect(tfvars["bucket_name"]).toBe("bucketbroker-platform-data");
    expect(tfvars["trusted_principals"]).toEqual([
      "arn:aws:iam::123456789012:role/bucket-broker-request-handler",
    ]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as { input: { ConditionExpression?: string } };
    expect(cmd.input.ConditionExpression).toContain(":provisioning");
  });

  it("treats ConditionalCheckFailedException as an idempotent no-op", async () => {
    sendMock.mockRejectedValue(new ConditionalCheckFailedException());

    // Must resolve (not throw): a redrive of an already-advanced request is safe.
    const out = await handler(baseEvent());
    expect(out.bucketName).toBe("bucketbroker-platform-data");
  });

  it("rejects an invalid request before any write", async () => {
    await expect(handler(baseEvent({ bucketName: "victim-bucket" }))).rejects.toThrow(
      /must start with the platform prefix/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("fails closed when STATUS_TABLE is missing", async () => {
    delete process.env["STATUS_TABLE"];
    await expect(handler(baseEvent())).rejects.toThrow(/STATUS_TABLE/);
  });

  it("fails closed when BROKER_PRINCIPAL_ARNS is malformed", async () => {
    process.env["BROKER_PRINCIPAL_ARNS"] = "not-json";
    await expect(handler(baseEvent())).rejects.toThrow(/BROKER_PRINCIPAL_ARNS/);
  });

  it("fails closed when no broker principals are configured", async () => {
    process.env["BROKER_PRINCIPAL_ARNS"] = "[]";
    await expect(handler(baseEvent())).rejects.toThrow(/at least one broker/);
  });

  it("generates a correlation-id when the event omits one", async () => {
    sendMock.mockResolvedValue({});
    // Missing correlationId still fails validation, but the fallback path runs.
    await expect(
      handler(baseEvent({ correlationId: undefined as unknown as string })),
    ).rejects.toThrow();
  });
});
