/**
 * Provisioner glue Lambda — invoked by the Step Functions RenderAndValidate task.
 *
 * Responsibilities:
 *   1. validate the untrusted request (validate.ts);
 *   2. render injection-safe JSON tfvars (render-tfvars.ts);
 *   3. perform the idempotent PENDING -> PROVISIONING status write (status.ts),
 *      wrapped in the shared resilience envelope (ADR-0004);
 *   4. return the data Step Functions needs to drive the CodeBuild apply.
 *
 * Reuses @bucket-broker/logging (structured logs + correlation-id) and
 * @bucket-broker/resilience (timeout + circuit breaker + jittered retry).
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { Context } from "aws-lambda";
import { Logger, adoptOrGenerate } from "@bucket-broker/logging";
import { ResiliencePolicy } from "@bucket-broker/resilience";
import { validateRequest } from "./validate";
import { renderTfvarsJson, stateKeyFor } from "./render-tfvars";
import { provisioningUpdateParams } from "./status";
import type { GlueConfig, ProvisionRequest, RenderResult } from "./types";

// Singletons — instantiated once per Lambda container.
const ddb = new DynamoDBClient({});

// One resilience envelope for the status-table dependency (ADR-0004). A
// ConditionalCheckFailedException means the record already advanced past
// PROVISIONING; it is an expected control outcome, not a transient fault, so it
// is non-retryable and handled as an idempotent no-op below.
const statusPolicy = new ResiliencePolicy({
  dependency: "status-table",
  timeoutMs: 3000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    totalBudgetMs: 5000,
    isRetryable: (err: unknown) => !isConditionalCheckFailed(err),
  },
  breaker: {
    failureThreshold: 0.5,
    rollingCount: 20,
    minimumThroughput: 5,
    openDurationMs: 10_000,
    halfOpenMaxProbes: 1,
    successThreshold: 2,
  },
});

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

function loadConfig(): GlueConfig {
  const statusTable = process.env["STATUS_TABLE"];
  const stateKeyPrefix = process.env["STATE_KEY_PREFIX"] ?? "provisioned";
  const provisionedBucketPrefix = process.env["PROVISIONED_BUCKET_PREFIX"] ?? "";
  const teamRolePermissionsBoundaryArn = process.env["TEAM_ROLE_PERMISSIONS_BOUNDARY_ARN"] ?? "";
  const brokerRaw = process.env["BROKER_PRINCIPAL_ARNS"] ?? "[]";

  if (!statusTable) {
    throw new Error("STATUS_TABLE environment variable is required");
  }

  // FAIL CLOSED: an empty prefix makes validate.ts `startsWith("")` always true,
  // silently disabling the ABAC namespace binding (the bound that keeps a request
  // inside the platform bucket namespace). Never provision without it.
  if (!provisionedBucketPrefix) {
    throw new Error("PROVISIONED_BUCKET_PREFIX environment variable is required");
  }

  // FAIL CLOSED: the provisioning role now REQUIRES every team role to carry this
  // permissions boundary at CreateRole (iam.tf). Without it, golden-bucket's
  // CreateRole is denied — so provisioning cannot proceed unbounded.
  if (!teamRolePermissionsBoundaryArn) {
    throw new Error("TEAM_ROLE_PERMISSIONS_BOUNDARY_ARN environment variable is required");
  }

  let brokerPrincipalArns: string[];
  try {
    const parsed: unknown = JSON.parse(brokerRaw);
    if (!Array.isArray(parsed) || !parsed.every((a): a is string => typeof a === "string")) {
      throw new Error("not a string array");
    }
    brokerPrincipalArns = parsed;
  } catch (err) {
    throw new Error(
      `BROKER_PRINCIPAL_ARNS must be a JSON string array: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (brokerPrincipalArns.length === 0) {
    throw new Error("BROKER_PRINCIPAL_ARNS must contain at least one broker principal ARN");
  }

  return {
    statusTable,
    stateKeyPrefix,
    provisionedBucketPrefix,
    teamRolePermissionsBoundaryArn,
    brokerPrincipalArns,
  };
}

async function writeProvisioning(
  logger: Logger,
  params: UpdateItemCommandInput,
  requestId: string,
): Promise<void> {
  try {
    await statusPolicy.execute(
      () => ddb.send(new UpdateItemCommand(params)),
      { idempotencyKey: `provisioning:${requestId}` },
    );
    logger.info("status set to PROVISIONING");
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // The record already advanced (duplicate execution / redrive). Idempotent.
      logger.warn("status already advanced past PROVISIONING; treating as no-op");
      return;
    }
    throw err;
  }
}

export async function handler(event: ProvisionRequest, context?: Context): Promise<RenderResult> {
  const correlationId =
    typeof event?.correlationId === "string" && event.correlationId.length > 0
      ? event.correlationId
      : adoptOrGenerate({ awsRequestId: context?.awsRequestId });

  const logger = new Logger({
    service: "provisioner-glue",
    layer: "lambda",
    correlationId,
  });

  const config = loadConfig();

  // 1. validate (throws ValidationError -> Step Functions Catch -> DLQ -> FAILED)
  const req = validateRequest(event, config.provisionedBucketPrefix);
  const requestLogger = logger.child({ requestId: req.requestId, bucketName: req.bucketName });
  requestLogger.info("request validated");

  // 2. render injection-safe JSON tfvars
  const tfvarsJson = renderTfvarsJson(
    req,
    config.brokerPrincipalArns,
    config.teamRolePermissionsBoundaryArn,
  );
  const stateKey = stateKeyFor(config.stateKeyPrefix, req.requestId);

  // 3. idempotent PENDING -> PROVISIONING
  const params = provisioningUpdateParams(config.statusTable, req.requestId, new Date().toISOString());
  await writeProvisioning(requestLogger, params, req.requestId);

  // 4. hand off to the CodeBuild apply. Return the VALIDATED correlationId
  // (req.correlationId) — it passed the allowlist regex, whereas the raw
  // `correlationId` above is only used to seed the logger before validation.
  return {
    requestId: req.requestId,
    correlationId: req.correlationId,
    bucketName: req.bucketName,
    team: req.team,
    stateKey,
    tfvarsJson,
  };
}
