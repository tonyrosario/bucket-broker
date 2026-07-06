/**
 * Stateless JWT parsing, RSA signature verification, and claim validation.
 *
 * Verification uses only Node's built-in `crypto` (no third-party JWT library),
 * so the authorizer ships with zero extra runtime dependencies. Only asymmetric
 * RSA algorithms are accepted; `none`, HMAC (`HS*`), EC, and RSA-PSS are
 * rejected outright, which structurally rules out the classic alg-confusion
 * attack (presenting an `HS256` token to be verified with the RSA public key as
 * an HMAC secret) — we never feed the key to a symmetric verifier.
 */

import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "crypto";
import { AuthDenied } from "./errors";
import type { Jwk } from "./jwks";

/** Decoded JOSE header. */
export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

/** Decoded JWT claim set. Only the claims we validate are typed explicitly. */
export interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
  [claim: string]: unknown;
}

/** A parsed token split into its verifiable parts. */
export interface DecodedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  /** The exact bytes the signature covers: `${headerB64url}.${payloadB64url}`. */
  signingInput: string;
  signature: Buffer;
}

/**
 * Node `crypto` digest algorithm per supported JWT `alg`. Membership in this
 * map is the allowlist: anything absent is rejected as `unsupported_alg`.
 */
const RSA_ALGS: Readonly<Record<string, string>> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

function base64UrlDecode(segment: string): Buffer {
  // Buffer accepts base64url directly in Node 16+, but normalise defensively.
  return Buffer.from(segment, "base64url");
}

function parseJsonSegment(segment: string, what: string): unknown {
  let json: string;
  try {
    json = base64UrlDecode(segment).toString("utf8");
  } catch {
    throw new AuthDenied("malformed_token", `Could not base64url-decode ${what}`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new AuthDenied("malformed_token", `${what} is not valid JSON`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Split and decode a compact JWS into header, payload and signature. Throws
 * {@link AuthDenied} (`malformed_token`) on any structural problem — never
 * returns a partially-parsed token.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthDenied("malformed_token", "Token does not have three segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new AuthDenied("malformed_token", "Token has an empty segment");
  }

  const headerRaw = parseJsonSegment(headerB64, "header");
  const payloadRaw = parseJsonSegment(payloadB64, "payload");

  if (!isObject(headerRaw) || typeof headerRaw["alg"] !== "string") {
    throw new AuthDenied("malformed_token", "Header missing string 'alg'");
  }
  if (!isObject(payloadRaw)) {
    throw new AuthDenied("malformed_token", "Payload is not a JSON object");
  }

  const header: JwtHeader = {
    alg: headerRaw["alg"],
    kid: typeof headerRaw["kid"] === "string" ? headerRaw["kid"] : undefined,
    typ: typeof headerRaw["typ"] === "string" ? headerRaw["typ"] : undefined,
  };

  return {
    header,
    payload: payloadRaw as JwtPayload,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64UrlDecode(signatureB64),
  };
}

/**
 * Assert the header `alg` is a supported asymmetric RSA algorithm. Rejecting
 * here (before any key lookup) means `none`/`HS*`/`ES*`/`PS*` can never reach
 * the verifier.
 */
export function assertSupportedAlg(alg: string): void {
  if (!(alg in RSA_ALGS)) {
    throw new AuthDenied("unsupported_alg", `Unsupported JWT alg: ${alg}`);
  }
}

/**
 * Verify the RSA signature of `signingInput` against a JWK. Returns `true`
 * only for a cryptographically valid signature. Throws
 * {@link AuthDenied} for an unusable key or unsupported algorithm.
 */
export function verifySignature(jwk: Jwk, alg: string, signingInput: string, signature: Buffer): boolean {
  const nodeAlg = RSA_ALGS[alg];
  if (!nodeAlg) {
    throw new AuthDenied("unsupported_alg", `Unsupported JWT alg: ${alg}`);
  }
  if (jwk.kty !== "RSA") {
    // Only RSA keys pair with the RS* allowlist. Anything else is a config
    // mismatch we refuse rather than coerce.
    throw new AuthDenied("invalid_signature", `JWK kty '${jwk.kty}' is not RSA`);
  }
  let key;
  try {
    key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  } catch {
    throw new AuthDenied("invalid_signature", "JWK could not be imported as a public key");
  }
  try {
    return cryptoVerify(nodeAlg, Buffer.from(signingInput), key, signature);
  } catch {
    // A malformed signature buffer can throw rather than return false — treat
    // as a failed verification (fail closed).
    return false;
  }
}

export interface ClaimValidationOptions {
  issuer: string;
  audience: string;
  /** Current wall-clock time in ms (injected for testability). */
  nowMs: number;
  /** Allowed clock skew, in seconds, applied to exp/nbf. */
  clockSkewSec: number;
}

/**
 * Validate issuer, audience, and the temporal claims (`exp` required, `nbf`
 * optional). Any mismatch or absent `exp` throws {@link AuthDenied}.
 */
export function validateClaims(payload: JwtPayload, opts: ClaimValidationOptions): void {
  if (payload.iss !== opts.issuer) {
    throw new AuthDenied("invalid_issuer", "Token issuer does not match configured issuer");
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!audiences.includes(opts.audience)) {
    throw new AuthDenied("invalid_audience", "Token audience does not include configured audience");
  }

  const nowSec = Math.floor(opts.nowMs / 1000);

  // `exp` is mandatory — a token without an expiry cannot be trusted.
  if (typeof payload.exp !== "number") {
    throw new AuthDenied("token_expired", "Token has no 'exp' claim");
  }
  if (nowSec > payload.exp + opts.clockSkewSec) {
    throw new AuthDenied("token_expired", "Token is expired");
  }

  if (typeof payload.nbf === "number" && nowSec < payload.nbf - opts.clockSkewSec) {
    throw new AuthDenied("token_not_yet_valid", "Token is not yet valid (nbf)");
  }
}

/**
 * Extract the caller's group claim as a normalised string array. Absent or
 * malformed group claims yield `[]` — NOT a denial. Per ADR-0006 the authorizer
 * does authN only; team→role/entitlement authorization is brokered downstream
 * from these groups, so an empty groups list is a valid (unentitled) identity,
 * not an authentication failure.
 */
export function extractGroups(payload: JwtPayload, groupsClaim: string): string[] {
  const raw = payload[groupsClaim];
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === "string");
  }
  if (typeof raw === "string" && raw.length > 0) {
    return [raw];
  }
  return [];
}
