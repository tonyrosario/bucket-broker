/**
 * Sensitive-field redaction for structured log entries.
 *
 * How it works
 * ─────────────
 * All field names are normalised before comparison:
 *   lower-cased + hyphens/underscores/spaces stripped.
 *
 * Matching uses **fragment/substring** semantics: a field is considered
 * sensitive if its normalised name CONTAINS any denylist fragment.  This
 * means compound keys like "client_secret" (→ "clientsecret") or
 * "x-api-key" (→ "xapikey") are caught by the "secret" and "apikey"
 * fragments respectively, without requiring an exact match.
 *
 * Examples:
 *   "Authorization"        → "authorization"   → contains "authorization" ✓
 *   "x-api-key"            → "xapikey"         → contains "apikey" ✓
 *   "client_secret"        → "clientsecret"    → contains "secret" ✓
 *   "sessionToken"         → "sessiontoken"    → contains "token" ✓
 *   "x-amz-security-token" → "xamzsecuritytoken" → contains "token" ✓
 *   "Set-Cookie"           → "setcookie"       → contains "cookie" ✓
 *   "userPassword"         → "userpassword"    → contains "password" ✓
 *
 * Redaction is **recursive**: nested objects and arrays are traversed and
 * any matching key at any depth has its value replaced with "[REDACTED]".
 *
 * Known limitation
 * ─────────────────
 * Redaction is key-based only.  Secrets embedded in free-text values (e.g.
 * a stack trace that happens to contain a token string, or a "message"
 * field whose value is "password=hunter2") are NOT redacted.  Callers
 * should not log free-text that may contain secrets.
 *
 * Built-in denylist
 * ──────────────────
 * DEFAULT_DENYLIST fragments are chosen to be specific enough to avoid
 * false-positive over-redaction of common benign keys such as "author",
 * "authorId", "description", "timestamp", "shipping", "region", "service",
 * "spanId".  Notably:
 *   • "auth" is NOT a fragment (would match "author", "oauth") — use
 *     "authorization" instead.
 *   • "pan" / "pin" are NOT fragments (match "company", "spinner", etc.)
 *
 * Configurable extension
 * ───────────────────────
 * Pass extra keys via `LoggerOptions.redactDenylist` or directly to
 * `createDenylist`. The normalisation rules apply, so callers can pass
 * "mySecretHeader" or "my-secret-header" interchangeably.
 */

/** Built-in list of sensitive field name fragments (normalised). */
export const DEFAULT_DENYLIST: ReadonlyArray<string> = [
  // Auth headers / tokens
  "authorization",   // Authorization header, x-authorization, etc.
  "token",           // sessionToken, accessToken, x-amz-security-token, etc.
  "bearer",          // Bearer token header value
  "jwt",             // JSON Web Token fields
  // API keys
  "apikey",          // x-api-key, api_key, apiKey, etc.
  // Secrets / credentials
  "secret",          // client_secret, dbSecret, secretKey, etc.
  "password",        // userPassword, resetPassword, etc.
  "passwd",          // short-form unix-style password field
  "credential",      // credential, credentials, credentialId, etc.
  // Crypto material
  "privatekey",      // private key material
  "signingkey",      // signing keys
  "encryptionkey",   // encryption keys
  // HTTP cookies
  "cookie",          // Cookie, Set-Cookie headers
  // PII / payment
  "ssn",             // Social Security Numbers
  "creditcard",      // credit card numbers
  "cardnumber",      // card number fields
  "cvv",             // card verification value
  "cvc",             // card verification code
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
 * Return true if the normalised key CONTAINS any denylist fragment.
 *
 * This is the core of the fragment/substring matching strategy: a field is
 * sensitive whenever its normalised name includes a sensitive substring,
 * so compound keys like "clientsecret" or "sessiontoken" are caught without
 * needing to enumerate every possible prefix.
 *
 * @internal
 */
function isSensitiveKey(normKey: string, denylist: Set<string>): boolean {
  for (const fragment of denylist) {
    if (normKey.includes(fragment)) return true;
  }
  return false;
}

/**
 * Build a Set of normalised denylist fragments from the default list plus any
 * custom entries provided by the caller.
 */
export function createDenylist(custom?: ReadonlyArray<string>): Set<string> {
  const combined: string[] = [...DEFAULT_DENYLIST, ...(custom ?? [])];
  return new Set(combined.map(normaliseKey));
}

/**
 * Internal recursive redact implementation.
 *
 * @param value    The value to redact.
 * @param denylist The compiled set of normalised fragment strings.
 * @param seen     WeakSet tracking visited objects to detect circular refs.
 */
function redactInner(value: unknown, denylist: Set<string>, seen: WeakSet<object>): unknown {
  // Handle BigInt — JSON.stringify throws on BigInt, so convert to string.
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  // Circular reference guard: return a sentinel rather than recursing forever.
  // At this point TypeScript knows value is object (non-null), so no cast needed.
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => redactInner(item, denylist, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(normaliseKey(k), denylist)) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = redactInner(v, denylist, seen);
    }
  }
  return result;
}

/**
 * Recursively redact sensitive fields from `value`.
 *
 * • Plain scalars (string, number, boolean, null) pass through unchanged.
 * • BigInt values are converted to their decimal string representation.
 * • Arrays: each element is redacted recursively.
 * • Objects: each key is normalised and checked against `denylist` using
 *   fragment/substring matching; matching keys have their value replaced with
 *   "[REDACTED]"; non-matching keys are redacted recursively.
 * • Circular references are replaced with the string "[Circular]".
 *
 * The input is never mutated — a new object/array is returned.
 *
 * @param value    The value to redact (typically a LogEntry or sub-object).
 * @param denylist The compiled set of normalised denylist fragments.
 */
export function redact(value: unknown, denylist: Set<string>): unknown {
  return redactInner(value, denylist, new WeakSet<object>());
}
