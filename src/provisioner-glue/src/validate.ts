/**
 * Input validation — the FIRST half of "validate input to the provisioner path"
 * (ADR-0003). Every user-influenced value is checked against a strict allowlist
 * regex BEFORE it is rendered into tfvars or used as an STS session-tag / shell
 * value. Values that pass validation contain only characters that are safe in
 * an S3 bucket name, an IAM name fragment, a JSON string, and a shell argument.
 *
 * This is defence-in-depth alongside JSON serialization (render-tfvars.ts): the
 * regexes reject metacharacters up front, and JSON.stringify guarantees that
 * even an unexpected value cannot break out of the tfvars document.
 */

import type { ProvisionRequest } from "./types";

export class ValidationError extends Error {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`invalid ${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

// Mirrors the golden-bucket module's bucket_name validation exactly (3-63 chars,
// lowercase alnum + dots + hyphens, must start/end alnum). No underscores, no
// uppercase, no metacharacters.
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// Team is embedded in an IAM role name and passed as an STS session tag, so it
// is restricted to a conservative, shell- and IAM-safe alphabet.
const TEAM_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const OWNER_RE = /^[A-Za-z0-9._%+@-]{1,128}$/;
const COST_CENTER_RE = /^[A-Za-z0-9-]{1,32}$/;
// requestId and correlationId flow into the state key path and session tags.
const REQUEST_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CORRELATION_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(field, "must be a non-empty string");
  }
  return value;
}

function match(value: string, re: RegExp, field: string): string {
  if (!re.test(value)) {
    throw new ValidationError(field, `must match ${re.toString()}`);
  }
  return value;
}

export interface ValidatedRequest {
  requestId: string;
  correlationId: string;
  bucketName: string;
  team: string;
  owner: string;
  costCenter: string;
  path: "golden" | "escape";
}

/**
 * Validate an untrusted provision request. Throws {@link ValidationError} on the
 * first offending field. `provisionedBucketPrefix` enforces that the bucket name
 * lives in the platform namespace (matching the ABAC bound in the provisioning
 * role's trust policy).
 */
export function validateRequest(
  input: Partial<ProvisionRequest> | undefined | null,
  provisionedBucketPrefix: string,
): ValidatedRequest {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("request", "must be an object");
  }

  const requestId = match(requireString(input.requestId, "requestId"), REQUEST_ID_RE, "requestId");
  const correlationId = match(
    requireString(input.correlationId, "correlationId"),
    CORRELATION_ID_RE,
    "correlationId",
  );
  const bucketName = match(requireString(input.bucketName, "bucketName"), BUCKET_NAME_RE, "bucketName");

  if (!bucketName.startsWith(provisionedBucketPrefix)) {
    throw new ValidationError(
      "bucketName",
      `must start with the platform prefix "${provisionedBucketPrefix}"`,
    );
  }

  const team = match(requireString(input.team, "team"), TEAM_RE, "team");
  const owner = match(requireString(input.owner, "owner"), OWNER_RE, "owner");
  const costCenter = match(requireString(input.costCenter, "costCenter"), COST_CENTER_RE, "costCenter");

  const path = input.path ?? "golden";
  if (path !== "golden" && path !== "escape") {
    throw new ValidationError("path", 'must be "golden" or "escape"');
  }

  return { requestId, correlationId, bucketName, team, owner, costCenter, path };
}
