/**
 * Test helper: mint RSA keypairs, publish their public halves as JWKs, and
 * sign JWTs — all with Node's built-in crypto, so tests exercise the exact
 * verification path the authorizer uses (no mocked crypto).
 */

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "crypto";
import type { Jwk } from "../../src/jwks";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Jwk;
}

const ALG_TO_DIGEST: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Generate an RSA keypair and expose its public half as a JWK with a `kid`. */
export function makeKey(kid: string, alg = "RS256"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Jwk;
  jwk.kid = kid;
  jwk.alg = alg;
  jwk.use = "sig";
  return { kid, privateKey, jwk };
}

export interface SignOptions {
  key: TestKey;
  payload: Record<string, unknown>;
  alg?: string;
  /** Override/omit the header `kid` (defaults to key.kid). Pass null to omit. */
  kid?: string | null;
  /** Override the header `alg` independently of the signing alg (for attacks). */
  headerAlg?: string;
}

/** Produce a signed compact JWS from a key + claim set. */
export function signJwt(opts: SignOptions): string {
  const alg = opts.alg ?? "RS256";
  const header: Record<string, unknown> = { alg: opts.headerAlg ?? alg, typ: "JWT" };
  if (opts.kid !== null) {
    header.kid = opts.kid ?? opts.key.kid;
  }
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(opts.payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const digest = ALG_TO_DIGEST[alg] ?? "RSA-SHA256";
  const signature = cryptoSign(digest, Buffer.from(signingInput), opts.key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** A standard, currently-valid claim set for the given issuer/audience. */
export function validClaims(issuer: string, audience: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    aud: audience,
    sub: "user-123",
    iat: nowSec,
    nbf: nowSec - 5,
    exp: nowSec + 3600,
    groups: ["platform-eng", "data-team"],
    ...extra,
  };
}
