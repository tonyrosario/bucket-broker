/**
 * SLO configuration tests.
 *
 * Validates that the constants governing the Step Functions execution
 * timeout (SLO_TIMEOUT_SECONDS) and the CodeBuild task timeout
 * (CODEBUILD_TASK_TIMEOUT_SECONDS) satisfy the ≤10-min SLO requirement
 * and are internally consistent.
 *
 * These constants must stay in sync with the TimeoutSeconds values in
 * terraform/skeleton/step_functions.tf.
 */

import {
  SLO_TIMEOUT_SECONDS,
  CODEBUILD_TASK_TIMEOUT_SECONDS,
} from "../src/constants.js";

describe("SLO timeout configuration", () => {
  test("SLO_TIMEOUT_SECONDS enforces the 10-minute (600-second) budget", () => {
    expect(SLO_TIMEOUT_SECONDS).toBe(600);
  });

  test("SLO_TIMEOUT_SECONDS does not exceed the 10-minute maximum", () => {
    expect(SLO_TIMEOUT_SECONDS).toBeLessThanOrEqual(600);
  });

  test("CODEBUILD_TASK_TIMEOUT_SECONDS is strictly less than SLO_TIMEOUT_SECONDS", () => {
    // CodeBuild task timeout must be shorter than the execution-level timeout
    // so there is headroom for the SetReady / SetFailed status writes to
    // complete before the Step Functions execution itself times out.
    expect(CODEBUILD_TASK_TIMEOUT_SECONDS).toBeLessThan(SLO_TIMEOUT_SECONDS);
  });

  test("CODEBUILD_TASK_TIMEOUT_SECONDS leaves at least 30 seconds of headroom", () => {
    const headroom = SLO_TIMEOUT_SECONDS - CODEBUILD_TASK_TIMEOUT_SECONDS;
    expect(headroom).toBeGreaterThanOrEqual(30);
  });

  test("CODEBUILD_TASK_TIMEOUT_SECONDS is 9 minutes (540 seconds)", () => {
    expect(CODEBUILD_TASK_TIMEOUT_SECONDS).toBe(540);
  });
});
