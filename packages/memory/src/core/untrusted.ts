/**
 * Untrusted-text write hygiene shared by EVERY write path (core), not just
 * the MCP tools.
 *
 * The serve-time quarantine envelope (`mcp/quarantine.ts`) wraps agent- and
 * repo-derived text in `<untrusted-…>…</untrusted-…>` so a future agent reads
 * it as data. That guarantee only holds if the stored text cannot contain a
 * delimiter that closes the envelope early. The MCP tools stripped those
 * tokens on write; the CLI path (`memory digest set`, `memory feature add` —
 * the path crew's onboarding flush and the runner's post-merge rollup use)
 * did not, so the "sanitised on write" claim was true for one of two doors.
 * Stripping in core closes both.
 *
 * ISOLATION: no imports from dispatch or crew.
 */

// Escape (never delete) the `<` of every untrusted-* delimiter — opening or closing,
// any tag, any case, padded with whitespace / zero-width characters, terminated or
// not. Deleting a delimiter in one pass let a nested token reassemble itself:
// `</untrus</untrusted-a>ted-x>` minus the inner token IS `</untrusted-x>`, which
// closed the envelope early. Escaping removes no text, so nothing can rejoin and one
// pass is safe (and idempotent). Same rule as crew's deliveryJudge.
/** Matches the `<` that opens any `<untrusted…` / `</untrusted…` delimiter. */
export const UNTRUSTED_TOKEN_RE =
  // eslint-disable-next-line no-control-regex -- the C0 separators are whitespace to python and to a model reading the prompt
  /<(?=[\s\x1c-\x1f\x85\u200b-\u200d\u2060]*\/?[\s\x1c-\x1f\x85\u200b-\u200d\u2060]*untrusted)/gi;

/**
 * Neutralise embedded envelope delimiters in an untrusted string (escape their
 * `<` to `&lt;`) so it cannot close the quarantine envelope early. The name is
 * historical — it used to delete the tokens, which a nested token defeated.
 * Null/undefined collapse to "".
 */
export function stripEnvelopeTokens(value: string | null | undefined): string {
  return String(value ?? "").replace(UNTRUSTED_TOKEN_RE, "&lt;");
}
