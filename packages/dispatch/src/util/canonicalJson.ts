import { createHash } from "node:crypto";

/**
 * Deterministic, canonical JSON serialization for tamper-evident hashing.
 *
 * The Delivery Dossier computes a content hash over its recorded-facts payload so
 * a re-generated dossier for an UNCHANGED ticket yields the SAME hash. That
 * requires a canonical encoding with no incidental variation:
 *  - object keys are emitted in sorted (code-unit) order, recursively;
 *  - array order is PRESERVED (it is meaningful — the assembler sorts collections
 *    by a stable key BEFORE they reach here);
 *  - `undefined` object members are omitted (so an absent optional never changes
 *    the bytes), and `undefined` inside an array serializes to `null` (as JSON has
 *    no undefined, matching JSON.stringify);
 *  - no insignificant whitespace.
 *
 * This is intentionally zero-dependency (matching the codebase style) and does
 * NOT rely on `JSON.stringify(value, keyArray)`, which cannot sort keys at every
 * nesting depth.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    // Non-finite numbers have no JSON form; encode as null like JSON.stringify.
    return Number.isFinite(value as number) ? String(value) : "null";
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") return (value as bigint).toString();
  if (Array.isArray(value)) {
    const items = value.map((v) => (v === undefined ? "null" : canonicalize(v)));
    return `[${items.join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue; // omit undefined members
      parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  // functions / symbols / undefined at the top level: no JSON form.
  return "null";
}

/** SHA-256 hex digest of a UTF-8 string. Same primitive as util/id + api/auth. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonicalize `value` and return its SHA-256 hex digest. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
