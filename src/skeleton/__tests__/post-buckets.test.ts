/**
 * Unit tests for POST /buckets handler.
 *
 * Mocks AWS SDK clients to verify:
 * - requestId is generated and returned
 * - DynamoDB is written with status=PENDING
 * - Step Functions execution is started with the requestId
 * - correlation-id is threaded from request header to response
 * - missing environment variables return 500
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEvent } from "aws-lambda";

// Mock the singleton clients before importing the handler module.
const ddbMock = mockClient(DynamoDBClient);
const sfnMock = mockClient(SFNClient);

// Import handler AFTER mocking so it picks up the mocked clients.
import { handler } from "../src/post-buckets.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_ENV = {
  REQUESTS_TABLE: "skeleton-requests",
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:skeleton-provisioner",
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    path: "/buckets",
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
    resource: "/buckets",
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

interface PostBucketsBody {
  requestId: string;
  status: string;
}

interface SFNInput {
  requestId: string;
  correlationId: string;
}

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  ddbMock.on(PutItemCommand).resolves({});
  sfnMock.on(StartExecutionCommand).resolves({
    executionArn: "arn:aws:states:us-east-1:123456789012:execution:skeleton-provisioner:test-id",
    startDate: new Date(),
  });
  process.env = { ...process.env, ...BASE_ENV };
});

afterEach(() => {
  delete process.env["REQUESTS_TABLE"];
  delete process.env["STATE_MACHINE_ARN"];
});

describe("POST /buckets — happy path", () => {
  test("returns 202 with a requestId and status=PENDING", async () => {
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as PostBucketsBody;
    expect(body.requestId).toMatch(UUID_RE);
    expect(body.status).toBe("PENDING");
  });

  test("writes to DynamoDB with status=PENDING", async () => {
    await handler(makeEvent());
    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0].args[0].input.Item;
    expect(item?.["status"]?.S).toBe("PENDING");
    expect(item?.["requestId"]?.S).toMatch(UUID_RE);
    expect(item?.["createdAt"]?.S).toBeTruthy();
  });

  test("writes ConditionExpression to guard against duplicate requestIds", async () => {
    await handler(makeEvent());
    const call = ddbMock.commandCalls(PutItemCommand)[0];
    expect(call.args[0].input.ConditionExpression).toBe("attribute_not_exists(requestId)");
  });

  test("starts Step Functions execution with the same requestId", async () => {
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body) as PostBucketsBody;
    const sfnCalls = sfnMock.commandCalls(StartExecutionCommand);
    expect(sfnCalls).toHaveLength(1);
    const sfnInput = sfnCalls[0].args[0];
    expect(sfnInput.input.name).toBe(body.requestId);
    const parsed = JSON.parse(sfnInput.input.input ?? "{}") as SFNInput;
    expect(parsed.requestId).toBe(body.requestId);
  });

  test("passes the state machine ARN from the environment", async () => {
    await handler(makeEvent());
    const sfnCall = sfnMock.commandCalls(StartExecutionCommand)[0];
    expect(sfnCall.args[0].input.stateMachineArn).toBe(BASE_ENV.STATE_MACHINE_ARN);
  });

  test("threads x-correlation-id from request header to response", async () => {
    const correlationId = "test-correlation-id-abc";
    const res = await handler(makeEvent({ headers: { "x-correlation-id": correlationId } }));
    expect(res.headers?.["x-correlation-id"]).toBe(correlationId);
    const sfnCall = sfnMock.commandCalls(StartExecutionCommand)[0];
    const parsed = JSON.parse(sfnCall.args[0].input.input ?? "{}") as SFNInput;
    expect(parsed.correlationId).toBe(correlationId);
  });

  test("generates a correlation-id when none is provided", async () => {
    const res = await handler(makeEvent());
    const correlationId = res.headers?.["x-correlation-id"];
    expect(correlationId).toMatch(UUID_RE);
  });
});

describe("POST /buckets — environment variable errors", () => {
  test("returns 500 when REQUESTS_TABLE is missing", async () => {
    delete process.env["REQUESTS_TABLE"];
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  test("returns 500 when STATE_MACHINE_ARN is missing", async () => {
    delete process.env["STATE_MACHINE_ARN"];
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  test("does not call DynamoDB when env vars are missing", async () => {
    delete process.env["REQUESTS_TABLE"];
    await handler(makeEvent());
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});
