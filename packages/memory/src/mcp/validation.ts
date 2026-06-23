/**
 * MCP input-length guards for fields that have a hard cap but used to
 * fail through zod's `.max()` validator. The zod path surfaced
 * "body is undefined" upstream when summary parse failed — the actual
 * cause was masked and agents gave up silently. These helpers replace
 * that with an actionable JSON response the agent can correct against
 * without a human round-trip:
 *
 *     { error: "summary_too_long", provided: 812, max: 800,
 *       suggested_cut: "<800-char truncation ending in '…'>",
 *       hint: "Retry with a shorter summary; body has no length limit." }
 *
 * Body length is deliberately uncapped — body is not returned in search
 * hits, only via `get_lore` on demand, so cost is opt-in. The cap on
 * title and summary protects the search-result payload size every
 * agent call pays for.
 */

export const LENGTH_CAPS = {
  title: 200,
  summary: 800,
} as const;

export type LengthCappedField = keyof typeof LENGTH_CAPS;

export interface TooLongError {
  readonly error: `${LengthCappedField}_too_long`;
  readonly provided: number;
  readonly max: number;
  /**
   * A draft truncation the agent can use as-is or as a starting point.
   * Exactly `max` chars in length: `max - 1` chars sliced from the
   * input, then a single-character ellipsis (`…`, U+2026). The agent
   * doesn't have to re-tokenise; it can just paste this back.
   */
  readonly suggested_cut: string;
  readonly hint: string;
}

/**
 * Check whether `value` fits within the cap for `field`. Returns `null`
 * (caller proceeds) when it fits; returns a `TooLongError` shape
 * otherwise — caller returns this verbatim to the agent and logs the
 * audit row.
 *
 * Boundary: `value.length === max` PASSES (returns null). Only
 * `value.length > max` triggers the error. Length is JS string length
 * (UTF-16 code units), consistent with the previous zod schema.
 */
export function checkLength(field: LengthCappedField, value: string): TooLongError | null {
  const max = LENGTH_CAPS[field];
  if (value.length <= max) return null;
  const suggested_cut = value.slice(0, max - 1) + "…";
  return {
    error: `${field}_too_long`,
    provided: value.length,
    max,
    suggested_cut,
    hint:
      field === "summary"
        ? "Retry with a shorter summary; body has no length limit."
        : "Retry with a shorter title; the summary cap is 800 chars and body has no length limit.",
  };
}

/**
 * Format the one-line string the audit log records when a too-long
 * input is rejected. Greppable shape: `"<field>_too_long: <n> > <max>"`.
 */
export function auditMessageForTooLong(err: TooLongError): string {
  return `${err.error}: ${err.provided} > ${err.max}`;
}
