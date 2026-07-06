/**
 * Sensitive-field redaction for structured log entries.
 *
 * How it works
 * ─────────────
 * All field names are normalised before comparison:
 *   lower-cased + hyphens/underscores/spaces stripped.
 *
 * This means "Authorization", "authorization", "AUTHORIZATION",
 * "x-authorization", and "auth_token" all normalise to the same token and
 * are matched by the denylist entry "authorization" or "authtoken".
 *
 * Redaction is **recursive**: nested objects and arrays are traversed and
 * any matching key at any depth has its value replaced with "[REDACTED]".
 *
 * Built-in denylist
 * ──────────────────
 * The DEFAULT_DENYLIST covers common categories of sensitive data:
 *   • Auth headers / tokens  (authorization, bearer, jwt, token, …)
 *   • API keys               (apikey, apitoken, …)
 *   • Secrets / credentials  (secret, password, credential, …)
 *   • Crypto material        (privatekey, signingkey, …)
 *   • PII / payment          (ssn, pan, cvv, creditcard, …)
 *
 * Configurable extension
 * ───────────────────────
 * Pass extra keys via `LoggerOptions.redactDenylist` or directly to
 * `createDenylist`. The normalisation rules apply, so callers can pass
 * "mySecretHeader" or "my-secret-header" interchangeably.
 */

/** Built-in list of sensitive field name fragments (normalised). */
export const DEFAULT_DENYLIST: ReadonlyArray<string> = [
  "authorization",
  "auth",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "apitoken",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "bearer",
  "jwt",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "ssn",
  "creditcard",
  "cardnumber",
  "pan",
  "cvv",
  "cvc",
  "pin",
];

/**
 * Normalise a field name for denylist comparison:
 * lower-case + strip hyphens, underscores, and spaces.
 *
 * @internal
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Build a Set of normalised denylist entries from the default list plus any
 * custom entries provided by the caller.
 */
export function createDenylist(custom?: ReadonlyArray<string>): Set<string> {
  const combined: string[] = [...DEFAULT_DENYLIST, ...(custom ?? [])];
  return new Set(combined.map(normaliseKey));
}

/**
 * Recursively redact sensitive fields from `value`.
 *
 * • Plain scalars (string, number, boolean, null) pass through unchanged.
 * • Arrays: each element is redacted recursively.
 * • Objects: each key is normalised and checked against `denylist`; matching
 *   keys have their value replaced with "[REDACTED]"; non-matching keys are
 *   redacted recursively.
 *
 * The input is never mutated — a new object/array is returned.
 *
 * @param value    The value to redact (typically a LogEntry or sub-object).
 * @param denylist The compiled set of normalised denied key names.
 */
export function redact(value: unknown, denylist: Set<string>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => redact(item, denylist));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (denylist.has(normaliseKey(k))) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = redact(v, denylist);
    }
  }
  return result;
}
