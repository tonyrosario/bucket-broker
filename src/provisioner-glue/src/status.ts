/**
 * Status-transition logic + the idempotent PROVISIONING write.
 *
 * The lifecycle is PENDING -> PROVISIONING -> READY | FAILED. The glue owns the
 * PENDING -> PROVISIONING transition; Step Functions owns the terminal writes
 * (state_machine.tf), each guarded by an equivalent ConditionExpression.
 */

import type { UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import type { RequestStatus } from "./types";

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

/**
 * DynamoDB UpdateItem params for the PENDING -> PROVISIONING transition.
 *
 * Idempotent by construction: the ConditionExpression only permits the write
 * when the record exists and is currently PENDING or already PROVISIONING. A
 * Step Functions redrive or a duplicate execution therefore re-applies the same
 * PROVISIONING state harmlessly, and can never regress a terminal READY/FAILED
 * record (the update is rejected with ConditionalCheckFailedException, which the
 * handler treats as an already-advanced no-op).
 */
export function provisioningUpdateParams(
  table: string,
  requestId: string,
  timestampIso: string,
): UpdateItemCommandInput {
  return {
    TableName: table,
    Key: { requestId: { S: requestId } },
    UpdateExpression: "SET #s = :provisioning, updatedAt = :ts",
    ConditionExpression: "attribute_exists(requestId) AND (#s = :pending OR #s = :provisioning)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":provisioning": { S: "PROVISIONING" },
      ":pending": { S: "PENDING" },
      ":ts": { S: timestampIso },
    },
  };
}
