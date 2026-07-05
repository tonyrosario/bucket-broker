/**
 * Status lifecycle tests.
 *
 * Validates the PENDING→PROVISIONING→READY/FAILED state-machine
 * transition rules that govern the bucket provision lifecycle.
 *
 * The Step Functions state machine (terraform/skeleton/step_functions.tf)
 * implements these transitions; these unit tests ensure the TypeScript
 * constants that document them are internally consistent.
 */

import {
  VALID_TRANSITIONS,
  isValidTransition,
  isTerminalStatus,
  type RequestStatus,
} from "../src/constants.js";

describe("Status lifecycle — valid transitions", () => {
  test("PENDING transitions only to PROVISIONING", () => {
    expect(VALID_TRANSITIONS.PENDING).toEqual(["PROVISIONING"]);
  });

  test("PROVISIONING transitions to READY on success", () => {
    expect(VALID_TRANSITIONS.PROVISIONING).toContain("READY");
  });

  test("PROVISIONING transitions to FAILED on error or timeout", () => {
    expect(VALID_TRANSITIONS.PROVISIONING).toContain("FAILED");
  });

  test("PROVISIONING has exactly two outbound transitions", () => {
    expect(VALID_TRANSITIONS.PROVISIONING).toHaveLength(2);
  });

  test("READY is a terminal state (no outbound transitions)", () => {
    expect(VALID_TRANSITIONS.READY).toHaveLength(0);
  });

  test("FAILED is a terminal state (no outbound transitions)", () => {
    expect(VALID_TRANSITIONS.FAILED).toHaveLength(0);
  });
});

describe("isValidTransition helper", () => {
  const validCases: Array<[RequestStatus, RequestStatus]> = [
    ["PENDING", "PROVISIONING"],
    ["PROVISIONING", "READY"],
    ["PROVISIONING", "FAILED"],
  ];

  test.each(validCases)("%s → %s is allowed", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  const invalidCases: Array<[RequestStatus, RequestStatus]> = [
    ["PENDING", "READY"],
    ["PENDING", "FAILED"],
    ["READY", "FAILED"],
    ["FAILED", "READY"],
    ["READY", "PENDING"],
    ["FAILED", "PENDING"],
    ["READY", "PROVISIONING"],
    ["FAILED", "PROVISIONING"],
  ];

  test.each(invalidCases)("%s → %s is rejected", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});

describe("isTerminalStatus helper", () => {
  test("PENDING is not terminal", () => {
    expect(isTerminalStatus("PENDING")).toBe(false);
  });

  test("PROVISIONING is not terminal", () => {
    expect(isTerminalStatus("PROVISIONING")).toBe(false);
  });

  test("READY is terminal", () => {
    expect(isTerminalStatus("READY")).toBe(true);
  });

  test("FAILED is terminal", () => {
    expect(isTerminalStatus("FAILED")).toBe(true);
  });
});
