import {
  assertSupportedAlg,
  decodeJwt,
  extractGroups,
  validateClaims,
  verifySignature,
  type JwtPayload,
} from "../src/jwt";
import { AuthDenied } from "../src/errors";
import { makeKey, signJwt, validClaims } from "./helpers/jwt-factory";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "api://bucket-broker";

describe("decodeJwt", () => {
  it("decodes a well-formed token into header/payload/signature", () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const decoded = decodeJwt(token);
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.header.kid).toBe("k1");
    expect(decoded.payload.iss).toBe(ISSUER);
    expect(decoded.signature.length).toBeGreaterThan(0);
  });

  it.each([
    ["two segments", "aaa.bbb"],
    ["one segment", "aaa"],
    ["empty segment", "aaa..ccc"],
  ])("rejects a structurally invalid token (%s)", (_desc, token) => {
    expect(() => decodeJwt(token)).toThrow(AuthDenied);
  });

  it("rejects a header that is not valid base64url JSON", () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const [, payload, sig] = token.split(".");
    expect(() => decodeJwt(`!!!notjson.${payload}.${sig}`)).toThrow(/header/i);
  });

  it("rejects a header without a string alg", () => {
    const headerB64 = Buffer.from(JSON.stringify({ typ: "JWT" })).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(() => decodeJwt(`${headerB64}.${payloadB64}.sig`)).toThrow(/alg/i);
  });
});

describe("assertSupportedAlg", () => {
  it("accepts RS256/RS384/RS512", () => {
    for (const alg of ["RS256", "RS384", "RS512"]) {
      expect(() => assertSupportedAlg(alg)).not.toThrow();
    }
  });

  it.each(["none", "HS256", "ES256", "PS256", "RS128"])("rejects %s (fail-closed)", (alg) => {
    expect(() => assertSupportedAlg(alg)).toThrow(AuthDenied);
  });
});

describe("verifySignature", () => {
  it("returns true for a valid RSA signature", () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const { signingInput, signature } = decodeJwt(token);
    expect(verifySignature(key.jwk, "RS256", signingInput, signature)).toBe(true);
  });

  it("returns false when the token is signed by a different key", () => {
    const signer = makeKey("k1");
    const attacker = makeKey("k1"); // same kid, different key material
    const token = signJwt({ key: signer, payload: validClaims(ISSUER, AUDIENCE) });
    const { signingInput, signature } = decodeJwt(token);
    expect(verifySignature(attacker.jwk, "RS256", signingInput, signature)).toBe(false);
  });

  it("returns false when the signing input is tampered", () => {
    const key = makeKey("k1");
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const { signature } = decodeJwt(token);
    expect(verifySignature(key.jwk, "RS256", "tampered.input", signature)).toBe(false);
  });

  it("throws for a non-RSA key (fail-closed)", () => {
    const key = makeKey("k1");
    const ecJwk = { ...key.jwk, kty: "EC" };
    const token = signJwt({ key, payload: validClaims(ISSUER, AUDIENCE) });
    const { signingInput, signature } = decodeJwt(token);
    expect(() => verifySignature(ecJwk, "RS256", signingInput, signature)).toThrow(AuthDenied);
  });

  it("throws for an unsupported alg", () => {
    const key = makeKey("k1");
    expect(() => verifySignature(key.jwk, "HS256", "a.b", Buffer.alloc(4))).toThrow(/unsupported/i);
  });
});

describe("validateClaims", () => {
  const base = { nowMs: Date.now(), clockSkewSec: 60 };

  it("passes for a valid claim set", () => {
    const payload = validClaims(ISSUER, AUDIENCE) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).not.toThrow();
  });

  it("accepts an array audience that includes the configured audience", () => {
    const payload = validClaims(ISSUER, AUDIENCE, { aud: ["other", AUDIENCE] }) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).not.toThrow();
  });

  it("rejects a wrong issuer", () => {
    const payload = validClaims("https://evil.example", AUDIENCE) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).toThrow(/issuer/i);
  });

  it("rejects a wrong audience", () => {
    const payload = validClaims(ISSUER, "api://someone-else") as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).toThrow(/audience/i);
  });

  it("rejects an expired token", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validClaims(ISSUER, AUDIENCE, { exp: nowSec - 3600 }) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).toThrow(/expired/i);
  });

  it("rejects a token with no exp", () => {
    const payload = validClaims(ISSUER, AUDIENCE) as JwtPayload;
    delete payload.exp;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).toThrow(/exp/i);
  });

  it("rejects a not-yet-valid token (nbf in the future)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validClaims(ISSUER, AUDIENCE, { nbf: nowSec + 3600 }) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, ...base })).toThrow(/not yet valid/i);
  });

  it("tolerates small clock skew on exp", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validClaims(ISSUER, AUDIENCE, { exp: nowSec - 30 }) as JwtPayload;
    expect(() => validateClaims(payload, { issuer: ISSUER, audience: AUDIENCE, nowMs: Date.now(), clockSkewSec: 60 })).not.toThrow();
  });
});

describe("extractGroups", () => {
  it("returns a string array unchanged", () => {
    expect(extractGroups({ groups: ["a", "b"] } as JwtPayload, "groups")).toEqual(["a", "b"]);
  });

  it("wraps a single string group", () => {
    expect(extractGroups({ groups: "solo" } as JwtPayload, "groups")).toEqual(["solo"]);
  });

  it("filters non-string array entries", () => {
    expect(extractGroups({ groups: ["a", 1, null, "b"] } as unknown as JwtPayload, "groups")).toEqual(["a", "b"]);
  });

  it("returns [] for an absent claim (NOT a denial — ADR-0006)", () => {
    expect(extractGroups({} as JwtPayload, "groups")).toEqual([]);
  });

  it("honours a custom claim name", () => {
    expect(extractGroups({ roles: ["x"] } as JwtPayload, "roles")).toEqual(["x"]);
  });
});
