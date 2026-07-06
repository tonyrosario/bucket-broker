/**
 * Shared types for the provisioner glue.
 */

/** Status lifecycle tracked in the DynamoDB status table. */
export type RequestStatus = "PENDING" | "PROVISIONING" | "READY" | "FAILED";

/**
 * The provision request as delivered to the glue Lambda by Step Functions
 * (the request-handler writes PENDING and starts the execution with this shape).
 */
export interface ProvisionRequest {
  requestId: string;
  correlationId: string;
  bucketName: string;
  team: string;
  owner: string;
  costCenter: string;
  /** Defaults to "golden" when omitted. */
  path?: "golden" | "escape";
}

/**
 * The glue Lambda's return payload, consumed by the Step Functions
 * RunCodeBuild task (env var overrides + session tags).
 */
export interface RenderResult {
  requestId: string;
  correlationId: string;
  bucketName: string;
  team: string;
  /** Per-request backend state key — isolates locks and ABAC state access. */
  stateKey: string;
  /** JSON tfvars (from JSON.stringify) written to terraform.auto.tfvars.json. */
  tfvarsJson: string;
}

/** Runtime configuration read from the Lambda environment. */
export interface GlueConfig {
  statusTable: string;
  stateKeyPrefix: string;
  provisionedBucketPrefix: string;
  brokerPrincipalArns: string[];
}
