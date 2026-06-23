/**
 * Secret redaction. Crew must redact likely secrets before any string
 * enters model context or an event payload. This is a defence-in-depth helper —
 * secret *files* are already denied by the filesystem guard, but inline strings
 * (tokens pasted into descriptions, env values, connection strings) still need
 * scrubbing.
 */

const REDACTED = "[REDACTED]";

interface SecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

// Ordered most-specific first. All are global + case-insensitive where useful.
const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private_key_block",
    regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi },
  { name: "connection_string", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi },
  {
    name: "assigned_secret",
    // KEY=value or "key": "value" where the key name looks sensitive.
    regex:
      /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)\b\s*[:=]\s*['"]?([^\s'"]+)['"]?/gi,
  },
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

/** Redact known secret shapes from a single string, reporting how many hits. */
export function redactSecrets(input: string): RedactionResult {
  let redactedCount = 0;
  let text = input;
  for (const { regex, name } of SECRET_PATTERNS) {
    text = text.replace(regex, (...args) => {
      redactedCount++;
      // assigned_secret keeps the key, masks the value.
      if (name === "assigned_secret") {
        const key = args[1] as string;
        return `${key}=${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return { text, redactedCount };
}

/** Convenience: returns the redacted string only. */
export function redact(input: string): string {
  return redactSecrets(input).text;
}

/** Deeply redact every string in a JSON-like value (for event payloads). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redact(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}
