import {
  VALID_TRANSITIONS,
  isValidTransition,
  isTerminalStatus,
  provisioningUpdateParams,
} from "../src/status";

describe("status transitions", () => {
  it("allows only the documented transitions", () => {
    expect(isValidTransition("PENDING", "PROVISIONING")).toBe(true);
    expect(isValidTransition("PROVISIONING", "READY")).toBe(true);
    expect(isValidTransition("PROVISIONING", "FAILED")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(isValidTransition("PENDING", "READY")).toBe(false);
    expect(isValidTransition("READY", "PROVISIONING")).toBe(false);
    expect(isValidTransition("FAILED", "READY")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminalStatus("READY")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("PENDING")).toBe(false);
    expect(isTerminalStatus("PROVISIONING")).toBe(false);
  });

  it("keeps READY and FAILED as sinks", () => {
    expect(VALID_TRANSITIONS.READY).toEqual([]);
    expect(VALID_TRANSITIONS.FAILED).toEqual([]);
  });
});

describe("provisioningUpdateParams", () => {
  const params = provisioningUpdateParams("bb-requests", "req-1", "2026-07-06T00:00:00.000Z");

  it("targets the right table + key", () => {
    expect(params.TableName).toBe("bb-requests");
    expect(params.Key).toEqual({ requestId: { S: "req-1" } });
  });

  it("is idempotent: only writes from PENDING or PROVISIONING", () => {
    expect(params.ConditionExpression).toBe(
      "attribute_exists(requestId) AND (#s = :pending OR #s = :provisioning)",
    );
    expect(params.ExpressionAttributeValues?.[":provisioning"]).toEqual({ S: "PROVISIONING" });
    expect(params.ExpressionAttributeValues?.[":pending"]).toEqual({ S: "PENDING" });
  });

  it("sets the PROVISIONING status and timestamp", () => {
    expect(params.UpdateExpression).toContain(":provisioning");
    expect(params.ExpressionAttributeValues?.[":ts"]).toEqual({ S: "2026-07-06T00:00:00.000Z" });
  });
});
