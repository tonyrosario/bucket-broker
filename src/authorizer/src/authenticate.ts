/**
 * Token authentication orchestration — authN ONLY (ADR-0006).
 *
 * This function proves the token is a genuine, unexpired credential issued by
 * the configured IdP for this audience, then extracts the caller's subject and
 * group claims. It makes NO authorization decision: it never allows or denies
 * based on group membership. Team→role/entitlement resolution is brokered by
 * the platform (entitlements table) in the request-handler (#19). An identity
 * with zero groups is still a successfully-authenticated identity here.
 */

import type { Logger } from "@bucket-broker/logging";
import type { OidcConfig } from "./config";
import { AuthDenied } from "./errors";
import type { JwksCache } from "./jwks";
import {
  assertSupportedAlg,
  decodeJwt,
  extractGroups,
  validateClaims,
  verifySignature,
  type JwtPayload,
} from "./jwt";

export interface AuthenticateDeps {
  config: Pick<OidcConfig, "issuer" | "audience">;
  jwksCache: JwksCache;
  logger: Logger;
  nowMs: number;
  clockSkewSec: number;
  groupsClaim: string;
}

/** A positively-validated caller identity, forwarded downstream unchanged. */
export interface Identity {
  sub: string;
  groups: string[];
  issuer: string;
  claims: JwtPayload;
}

/**
 * Validate a raw JWT string. Resolves to an {@link Identity} on success; throws
 * {@link AuthDenied} on any failure (the fail-closed path). The order is
 * deliberate: cheap structural/alg checks first, then key lookup + signature,
 * then claims — so a malformed or wrong-alg token never triggers a JWKS fetch.
 */
export async function authenticate(token: string, deps: AuthenticateDeps): Promise<Identity> {
  const { header, payload, signingInput, signature } = decodeJwt(token);

  assertSupportedAlg(header.alg);
  if (!header.kid) {
    throw new AuthDenied("missing_kid", "Token header has no 'kid'");
  }

  const jwk = await deps.jwksCache.getKey(header.kid, deps.logger);

  if (!verifySignature(jwk, header.alg, signingInput, signature)) {
    throw new AuthDenied("invalid_signature", "Token signature verification failed");
  }

  validateClaims(payload, {
    issuer: deps.config.issuer,
    audience: deps.config.audience,
    nowMs: deps.nowMs,
    clockSkewSec: deps.clockSkewSec,
  });

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new AuthDenied("missing_claim", "Token has no 'sub' claim");
  }

  return {
    sub,
    groups: extractGroups(payload, deps.groupsClaim),
    issuer: payload.iss ?? deps.config.issuer,
    claims: payload,
  };
}
