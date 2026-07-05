/**
 * Unit tests for GET /buckets/{id} handler.
 *
 * Mocks DynamoDB to verify:
 * - known requestId returns the record with status
 * - unknown requestId returns 404
 * - missing path parameter returns 400
 * - missing environment variable returns 500
 * - all valid statuses are returned correctly
 * - correlation-id is threaded to the response
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";

const ddbMock = mockClient(DynamoDBClient);

import { handler } from "../src/get-bucket.js";
import type { RequestStatus } from "../src/constants.js";
import type { BucketStatusResponse } from "../src/get-bucket.js";

function makeEvent(id?: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    path: `/buckets/${id ?? ""}`,
    headers,
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: id !== undefined ? { id } : null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
    resource: "/buckets/{id}",
    body: null,
    isBase64Encoded: false,
  };
}

const FIXED_REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const REQUESTS_TABLE = "skeleton-requests";

beforeEach(() => {
  ddbMock.reset();
  process.env["REQUESTS_TABLE"] = REQUESTS_TABLE;
});

afterEach(() => {
  delete process.env["REQUESTS_TABLE"];
});

describe("GET /buckets/{id} — found", () => {
  const statuses: RequestStatus[] = ["PENDING", "PROVISIONING", "READY", "FAILED"];

  test.each(statuses)("returns 200 with status=%s", async (status) => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        requestId: { S: FIXED_REQUEST_ID },
        status: { S: status },
        createdAt: { S: "2026-07-04T00:00:00.000Z" },
      },
    });

    const res = await handler(makeEvent(FIXED_REQUEST_ID));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as BucketStatusResponse;
    expect(body.requestId).toBe(FIXED_REQUEST_ID);
    expect(body.status).toBe(status);
    expect(body.createdAt).toBe("2026-07-04T00:00:00.000Z");
  });

  test("returns optional timestamp fields when present", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        requestId: { S: FIXED_REQUEST_ID },
        status: { S: "READY" },
        createdAt: { S: "2026-07-04T00:00:00.000Z" },
        updatedAt: { S: "2026-07-04T00:01:00.000Z" },
        completedAt: { S: "2026-07-04T00:02:00.000Z" },
      },
    });

    const res = await handler(makeEvent(FIXED_REQUEST_ID));
    const body = JSON.parse(res.body) as BucketStatusResponse;
    expect(body.updatedAt).toBe("2026-07-04T00:01:00.000Z");
    expect(body.completedAt).toBe("2026-07-04T00:02:00.000Z");
    expect(body.failedAt).toBeUndefined();
  });

  test("threads x-correlation-id from request header to response", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        requestId: { S: FIXED_REQUEST_ID },
        status: { S: "PENDING" },
        createdAt: { S: "2026-07-04T00:00:00.000Z" },
      },
    });

    const res = await handler(makeEvent(FIXED_REQUEST_ID, { "x-correlation-id": "my-trace-id" }));
    expect(res.headers?.["x-correlation-id"]).toBe("my-trace-id");
  });

  test("queries DynamoDB with the correct requestId key", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        requestId: { S: FIXED_REQUEST_ID },
        status: { S: "PENDING" },
        createdAt: { S: "2026-07-04T00:00:00.000Z" },
      },
    });

    await handler(makeEvent(FIXED_REQUEST_ID));
    const calls = ddbMock.commandCalls(GetItemCommand);
    expect(calls).toHaveLength(1);
    const key = calls[0].args[0].input.Key;
    expect(key?.["requestId"]?.S).toBe(FIXED_REQUEST_ID);
  });
});

describe("GET /buckets/{id} — not found", () => {
  test("returns 404 when requestId does not exist", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const res = await handler(makeEvent("does-not-exist"));
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /buckets/{id} — bad input", () => {
  test("returns 400 when path parameter id is missing", async () => {
    const res = await handler(makeEvent(undefined));
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /buckets/{id} — correlation-id", () => {
  test("generates a UUID correlation-id when no header is provided", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const res = await handler(makeEvent("no-header-request"));
    const cid = res.headers?.["x-correlation-id"];
    expect(cid).not.toBe("unknown");
    expect(cid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("GET /buckets/{id} — DynamoDB failures", () => {
  test("returns 500 when the DynamoDB read throws", async () => {
    ddbMock.on(GetItemCommand).rejects(new Error("ProvisionedThroughputExceededException"));
    const res = await handler(makeEvent(FIXED_REQUEST_ID, { "x-correlation-id": "corr-500" }));
    expect(res.statusCode).toBe(500);
    expect(res.headers?.["x-correlation-id"]).toBe("corr-500");
  });
});

describe("GET /buckets/{id} — environment variable errors", () => {
  test("returns 500 when REQUESTS_TABLE is missing", async () => {
    delete process.env["REQUESTS_TABLE"];
    const res = await handler(makeEvent(FIXED_REQUEST_ID));
    expect(res.statusCode).toBe(500);
  });

  test("does not call DynamoDB when REQUESTS_TABLE is missing", async () => {
    delete process.env["REQUESTS_TABLE"];
    await handler(makeEvent(FIXED_REQUEST_ID));
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });
});
