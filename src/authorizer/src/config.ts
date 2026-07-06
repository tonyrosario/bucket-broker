/**
 * OIDC configuration, read from SSM Parameter Store at cold start.
 *
 * Nothing about the IdP is hardcoded: the issuer, audience, and JWKS URI live
 * in SSM (published by the identity module, #12) and are addressed here only by
 * their parameter *names*, supplied as environment variables. Swapping the IdP
 * is a data change (SSM + entitlements table), never a code change.
 *
 * The JWKS URI parameter is a SecureString, so the read is done
 * `WithDecryption: true`; the authorizer's execution role is granted
 * `ssm:GetParameters` on exactly these three parameters and `kms:Decrypt` on
 * the identity CMK (least privilege — see modules/platform-api).
 */

import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { AuthDenied } from "./errors";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/** SSM parameter *names* (not values) for the three OIDC config entries. */
export interface OidcParamNames {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/**
 * Load the OIDC config from SSM. Throws {@link AuthDenied} (`config_error`) if
 * any parameter is missing or empty — the authorizer then fails closed rather
 * than validate tokens against partial config.
 */
export async function loadOidcConfig(client: SSMClient, names: OidcParamNames): Promise<OidcConfig> {
  const res = await client.send(
    new GetParametersCommand({
      Names: [names.issuer, names.audience, names.jwksUri],
      WithDecryption: true,
    }),
  );

  const byName = new Map<string, string>();
  for (const p of res.Parameters ?? []) {
    if (p.Name && typeof p.Value === "string") {
      byName.set(p.Name, p.Value);
    }
  }

  const issuer = byName.get(names.issuer);
  const audience = byName.get(names.audience);
  const jwksUri = byName.get(names.jwksUri);

  if (!issuer || !audience || !jwksUri) {
    const invalid = res.InvalidParameters ?? [];
    throw new AuthDenied(
      "config_error",
      `Missing OIDC SSM parameter(s)${invalid.length ? `: ${invalid.join(", ")}` : ""}`,
    );
  }

  return { issuer, audience, jwksUri };
}
