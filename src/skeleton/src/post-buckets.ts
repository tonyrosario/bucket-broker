/**
 * POST /buckets — Walking skeleton request handler.
 *
 * Accepts a provision request (no auth, no WAF — skeleton only),
 * writes PENDING to DynamoDB, starts a Step Functions execution,
 * and returns 202 with the requestId.
 *
 * Structured logging carries a correlation-id on every log line.
 * The correlation-id is taken from the x-correlation-id request header
 * or generated as a UUID if absent.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { randomUUID } from "crypto";

// Singleton clients — instantiated once per Lambda container.
export const ddbClient = new DynamoDBClient({});
export const sfnClient = new SFNClient({});

export interface ExecutionInput {
  requestId: string;
  correlationId: string;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const correlationId =
    (event.headers?.["x-correlation-id"] ?? event.headers?.["X-Correlation-Id"]) ?? randomUUID();

  const requestId = randomUUID();

  const logCtx = { correlationId, requestId };

  log("INFO", "POST /buckets received", logCtx);

  const requestsTable = process.env["REQUESTS_TABLE"];
  const stateMachineArn = process.env["STATE_MACHINE_ARN"];

  if (!requestsTable || !stateMachineArn) {
    log("ERROR", "Missing required environment variables", {
      ...logCtx,
      missingVars: [...(!requestsTable ? ["REQUESTS_TABLE"] : []), ...(!stateMachineArn ? ["STATE_MACHINE_ARN"] : [])],
    });
    return errorResponse(500, "Internal configuration error", correlationId);
  }

  // Write request record with status=PENDING.
  // ConditionExpression guards against duplicate requestIds (UUID collision is
  // astronomically unlikely but explicit idempotency is good practice).
  try {
    await ddbClient.send(
      new PutItemCommand({
        TableName: requestsTable,
        Item: {
          requestId: { S: requestId },
          status: { S: "PENDING" },
          createdAt: { S: new Date().toISOString() },
          correlationId: { S: correlationId },
        },
        ConditionExpression: "attribute_not_exists(requestId)",
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      log("WARN", "Duplicate requestId — record already exists", logCtx);
      return errorResponse(409, "Request already exists", correlationId);
    }
    log("ERROR", "Failed to write request to DynamoDB", {
      ...logCtx,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(500, "Failed to record request", correlationId);
  }

  log("INFO", "Request written to DynamoDB with status=PENDING", logCtx);

  // Start Step Functions execution. Execution name = requestId so it is
  // idempotent: a duplicate call for the same requestId will get
  // ExecutionAlreadyExists from SF (handled by the caller's retry logic).
  const sfnInput: ExecutionInput = { requestId, correlationId };

  try {
    await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: requestId,
        input: JSON.stringify(sfnInput),
      }),
    );
  } catch (err) {
    // The PENDING record persists with no execution. A sweeper (deferred to
    // #25) reconciles orphaned PENDING records; here we surface the failure.
    log("ERROR", "Failed to start Step Functions execution", {
      ...logCtx,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(500, "Failed to start provisioning", correlationId);
  }

  log("INFO", "Step Functions execution started", logCtx);

  return {
    statusCode: 202,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify({ requestId, status: "PENDING" }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  context: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...context }));
}

function errorResponse(
  statusCode: number,
  message: string,
  correlationId: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify({ error: message }),
  };
}
