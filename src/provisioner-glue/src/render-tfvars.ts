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
}

/**
 * Build the tfvars object for a validated request. `brokerPrincipalArns` are the
 * concrete platform broker principals the team role will trust (ADR-0006).
 */
export function buildTfvars(req: ValidatedRequest, brokerPrincipalArns: string[]): GoldenBucketTfvars {
  return {
    bucket_name: req.bucketName,
    team: req.team,
    owner: req.owner,
    cost_center: req.costCenter,
    path: req.path,
    trusted_principals: brokerPrincipalArns,
  };
}

/**
 * Render the tfvars as a JSON string suitable for `terraform.auto.tfvars.json`.
 * This is the single choke point that guarantees no HCL injection.
 */
export function renderTfvarsJson(req: ValidatedRequest, brokerPrincipalArns: string[]): string {
  return JSON.stringify(buildTfvars(req, brokerPrincipalArns));
}

/** Per-request backend state key: isolates locks and matches the ABAC scope. */
export function stateKeyFor(stateKeyPrefix: string, requestId: string): string {
  return `${stateKeyPrefix}/${requestId}/terraform.tfstate`;
}
