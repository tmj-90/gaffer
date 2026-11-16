/**
 * The ONE TypeScript escaper for untrusted text placed inside an `<untrusted-*>`
 * envelope (dispatch's MCP tools; crew imports it as `dispatch/untrusted`).
 *
 * Rule: EVERY `<` of the untrusted text becomes `&lt;`; nothing else changes. Matching
 * the closing tag could not win: the old regex escaped only a `<` followed by optional
 * spaces, a slash and "untrusted", and a soft hyphen, an invisible character inside the
 * word or a Cyrillic look-alike letter walked past it. With no raw `<` left there is no
 * closing tag to forge, however it is spelled.
 *
 * `&` is NOT escaped, on purpose: the transform is idempotent (escaping twice changes
 * nothing, so a field escaped at render time and wrapped again stays readable), at the
 * cost of strict reversibility (a literal "&lt;" in the data reads as "<"). Nothing
 * decodes the wrapped text; only a model reads it.
 *
 * Twins: runner/lib/untrusted.mjs (runner side) and packages/memory/src/core/untrusted.ts
 * (memory may not import dispatch). All three run runner/test/fixtures/quarantine-vectors.json.
 */

/** The sentence every quarantine notice carries so the model reads `&lt;` right. */
export const QUARANTINE_ESCAPE_NOTE = "&lt; inside these tags is a literal <.";

/** Escape every `<` of an untrusted value to `&lt;` (null/undefined become ""). */
export function escapeUntrusted(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return raw.replace(/</g, "&lt;");
}

/** `<untrusted-TAG>…</untrusted-TAG>` around the escaped value. */
export function quarantine(tag: string, value: unknown): string {
  return `<untrusted-${tag}>${escapeUntrusted(value)}</untrusted-${tag}>`;
}
