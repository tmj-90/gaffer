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

/** Matches an opening or closing `<untrusted-…>` delimiter token. */
export const UNTRUSTED_TOKEN_RE = /<\/?untrusted-[^>]*>/gi;

/**
 * Strip embedded envelope delimiter tokens from an untrusted string so it
 * cannot close the quarantine envelope early. Null/undefined collapse to "".
 */
export function stripEnvelopeTokens(value: string | null | undefined): string {
  return String(value ?? "").replace(UNTRUSTED_TOKEN_RE, "");
}
