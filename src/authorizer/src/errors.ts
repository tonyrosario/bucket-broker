/**
 * Fail-closed denial taxonomy for the JWT authorizer.
 *
 * Every path that cannot produce a positively-validated token throws an
 * {@link AuthDenied}. The handler catches it, emits a structured log carrying
 * the `reason` (never the raw token), and returns a 401 to API Gateway. The
 * reasons are deliberately coarse so logs never leak token internals while
 * still being precise enough for a CloudWatch metric filter / alarm.
 *
 * ADR-0004: unknown `kid`, no cached key, expired, bad signature/iss/aud, or
 * any validation doubt → deny. Security is never traded for availability.
 */
export type DenyReason =
  | "missing_token"
  | "malformed_token"
  | "unsupported_alg"
  | "missing_kid"
  | "unknown_kid"
  | "no_cached_key"
  | "invalid_signature"
  | "invalid_issuer"
  | "invalid_audience"
  | "token_expired"
  | "token_not_yet_valid"
  | "missing_claim"
  | "config_error";

/**
 * A validation failure that MUST result in a 401. Carries a machine-readable
 * `reason` for structured logging; the human `message` adds context but is
 * kept free of token material.
 */
export class AuthDenied extends Error {
  public readonly reason: DenyReason;

  constructor(reason: DenyReason, message?: string) {
    super(message ?? reason);
    this.name = "AuthDenied";
    this.reason = reason;
    // Restore the prototype chain (TS target ES2022 downlevels `extends Error`).
    Object.setPrototypeOf(this, AuthDenied.prototype);
  }
}
