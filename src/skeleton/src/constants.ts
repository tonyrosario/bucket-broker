/**
 * Walking skeleton constants.
 *
 * SLO_TIMEOUT_SECONDS must match the Step Functions state machine's
 * top-level TimeoutSeconds in terraform/skeleton/step_functions.tf.
 *
 * CODEBUILD_TASK_TIMEOUT_SECONDS must be < SLO_TIMEOUT_SECONDS to
 * leave headroom for status writes before the execution-level timeout fires.
 */

export const SLO_TIMEOUT_SECONDS = 600; // 10 minutes

export const CODEBUILD_TASK_TIMEOUT_SECONDS = 540; // 9 minutes

export type RequestStatus = "PENDING" | "PROVISIONING" | "READY" | "FAILED";

/**
 * Valid status transitions for the bucket provision lifecycle.
 * The Step Functions state machine enforces these transitions:
 *   Lambda writes PENDING on StartExecution.
 *   SetProvisioning state writes PROVISIONING.
 *   SetReady writes READY on CodeBuild success.
 *   SetFailed writes FAILED on CodeBuild failure or SLO timeout.
 */
export const VALID_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  PENDING: ["PROVISIONING"],
  PROVISIONING: ["READY", "FAILED"],
  READY: [],
  FAILED: [],
} as const;

export function isValidTransition(from: RequestStatus, to: RequestStatus): boolean {
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isTerminalStatus(status: RequestStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}
