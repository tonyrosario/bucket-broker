/**
 * GET /buckets/{id} — Walking skeleton status reader.
 *
 * Reads the provision request record from DynamoDB and returns the
 * current status (PENDING | PROVISIONING | READY | FAILED).
 *
 * Structured logging carries a correlation-id on every log line.
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { RequestStatus } from "./constants.js";

// Singleton client — instantiated once per Lambda container.
export const ddbClient = new DynamoDBClient({});

export interface BucketStatusResponse {
  requestId: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  failedAt?: string;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const correlationId =
    (event.headers?.["x-correlation-id"] ?? event.headers?.["X-Correlation-Id"]) ?? "unknown";

  const requestId = event.pathParameters?.["id"];

  const logCtx = { correlationId, requestId };

  log("INFO", "GET /buckets/{id} received", logCtx);

  if (!requestId) {
    return jsonResponse(400, { error: "Missing path parameter: id" }, correlationId);
  }

  const requestsTable = process.env["REQUESTS_TABLE"];

  if (!requestsTable) {
    log("ERROR", "Missing REQUESTS_TABLE environment variable", logCtx);
    return jsonResponse(500, { error: "Internal configuration error" }, correlationId);
  }

  const result = await ddbClient.send(
    new GetItemCommand({
      TableName: requestsTable,
      Key: { requestId: { S: requestId } },
      // Only fetch the fields we return — least-privilege data access.
      ProjectionExpression: "requestId, #s, createdAt, updatedAt, completedAt, failedAt",
      ExpressionAttributeNames: { "#s": "status" },
    }),
  );

  if (!result.Item) {
    log("WARN", "Request not found", logCtx);
    return jsonResponse(404, { error: "Not found" }, correlationId);
  }

  const item = result.Item;
  const status = item["status"]?.S as RequestStatus | undefined;

  if (!status) {
    log("ERROR", "Request record missing status field", logCtx);
    return jsonResponse(500, { error: "Corrupted record" }, correlationId);
  }

  log("INFO", "Request found", { ...logCtx, status });

  const body: BucketStatusResponse = {
    requestId: item["requestId"]?.S ?? requestId,
    status,
    createdAt: item["createdAt"]?.S ?? "",
    ...(item["updatedAt"]?.S !== undefined ? { updatedAt: item["updatedAt"].S } : {}),
    ...(item["completedAt"]?.S !== undefined ? { completedAt: item["completedAt"].S } : {}),
    ...(item["failedAt"]?.S !== undefined ? { failedAt: item["failedAt"].S } : {}),
  };

  return jsonResponse(200, body, correlationId);
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

function jsonResponse(
  statusCode: number,
  body: unknown,
  correlationId: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify(body),
  };
}
