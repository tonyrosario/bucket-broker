/**
 * tfvars rendering — the SECOND half of injection safety (#16 security note /
 * ADR-0003).
 *
 * User-influenced values are NEVER string-concatenated into HCL. Instead the
 * whole variable set is serialized with JSON.stringify and written to
 * `terraform.auto.tfvars.json`, which Terraform loads with its native JSON
 * tfvars parser. Because HCL string literals are JSON-compatible, this is a
 * lossless, safe representation: any quote, backslash, `${...}`, newline, or
 * other HCL metacharacter in a value is JSON-escaped and therefore cannot close
 * the string or introduce new HCL tokens/variables. There is no HCL lexing of
 * untrusted text at any point.
 */

import type { ValidatedRequest } from "./validate";

/** The exact variable set the golden-bucket runner root expects. */
export interface GoldenBucketTfvars {
  bucket_name: string;
  team: string;
  owner: string;
  cost_center: string;
  path: "golden" | "escape";
  trusted_principals: string[];
  /**
   * Permissions boundary the runner root attaches to the team role. The
   * provisioning role's iam:CreateRole grant requires this exact boundary
   * (iam.tf), so the team role can never exceed the golden-bucket CRUD surface.
   */
  team_role_permissions_boundary_arn: string;
}

/**
 * Build the tfvars object for a validated request. `brokerPrincipalArns` are the
 * concrete platform broker principals the team role will trust (ADR-0006);
 * `teamRolePermissionsBoundaryArn` is the mandatory team-role permissions
 * boundary (see {@link GoldenBucketTfvars}).
 */
export function buildTfvars(
  req: ValidatedRequest,
  brokerPrincipalArns: string[],
  teamRolePermissionsBoundaryArn: string,
): GoldenBucketTfvars {
  return {
    bucket_name: req.bucketName,
    team: req.team,
    owner: req.owner,
    cost_center: req.costCenter,
    path: req.path,
    trusted_principals: brokerPrincipalArns,
    team_role_permissions_boundary_arn: teamRolePermissionsBoundaryArn,
  };
}

/**
 * Render the tfvars as a JSON string suitable for `terraform.auto.tfvars.json`.
 * This is the single choke point that guarantees no HCL injection.
 */
export function renderTfvarsJson(
  req: ValidatedRequest,
  brokerPrincipalArns: string[],
  teamRolePermissionsBoundaryArn: string,
): string {
  return JSON.stringify(buildTfvars(req, brokerPrincipalArns, teamRolePermissionsBoundaryArn));
}

/** Per-request backend state key: isolates locks and matches the ABAC scope. */
export function stateKeyFor(stateKeyPrefix: string, requestId: string): string {
  return `${stateKeyPrefix}/${requestId}/terraform.tfstate`;
}
