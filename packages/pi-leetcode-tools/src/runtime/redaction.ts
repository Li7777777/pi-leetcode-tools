export const REDACTED_VALUE = "[REDACTED]";
export const CIRCULAR_VALUE = "[Circular]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "session",
  "leetcodesession",
  "csrf",
  "csrftoken",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "credential",
  "credentials",
  "code",
  "content",
  "body",
  "requestbody",
  "responsebody"
]);

function canonicalKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const canonical = canonicalKey(key);
  return (
    SENSITIVE_KEYS.has(canonical) ||
    canonical.endsWith("password") ||
    canonical.endsWith("secret") ||
    canonical.endsWith("session") ||
    canonical.endsWith("token")
  );
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

export class Redactor {
  readonly #secrets: readonly string[];

  constructor(secrets: Iterable<string> = []) {
    this.#secrets = [...new Set([...secrets].filter((value) => value.length > 0))].sort(
      (left, right) => right.length - left.length
    );
  }

  redactText(value: string): string {
    let redacted = value;
    for (const secret of this.#secrets) {
      redacted = replaceAllLiteral(redacted, secret, REDACTED_VALUE);
    }

    redacted = redacted.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
      `$1 ${REDACTED_VALUE}`
    );
    redacted = redacted.replace(
      /\b(LEETCODE_SESSION|csrftoken)\s*=\s*[^;\s,]+/giu,
      `$1=${REDACTED_VALUE}`
    );
    return redacted;
  }

  redact(value: unknown): unknown {
    return this.#redact(value, new WeakSet<object>());
  }

  #redact(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "undefined"
    ) {
      return value;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "symbol" || typeof value === "function") {
      return `[${typeof value}]`;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: this.redactText(value.name),
        message: this.redactText(value.message)
      };
    }
    if (ArrayBuffer.isView(value)) {
      return `[binary:${value.byteLength} bytes]`;
    }
    if (seen.has(value)) {
      return CIRCULAR_VALUE;
    }

    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.#redact(item, seen));
    }
    if (value instanceof Map) {
      return [...value.entries()].map(([key, item]) => [
        this.#redact(key, seen),
        this.#redact(item, seen)
      ]);
    }
    if (value instanceof Set) {
      return [...value].map((item) => this.#redact(item, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED_VALUE : this.#redact(item, seen);
    }
    return output;
  }
}
