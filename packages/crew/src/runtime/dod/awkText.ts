// =====================================================================
// awk text-record helpers — the shared line-splitting / line-joining
// primitives the DoD distill/extract ports use to stay BYTE-IDENTICAL to
// the awk they replace (runner/lib/dod.sh). Kept in one tiny module so the
// two ports (distillOutput, extractFailure) split and join records the
// SAME way, and so the awk record semantics are unit-tested in one place.
// ---------------------------------------------------------------------
// awk's default record separator is RS="\n": a file's records are its
// newline-terminated lines, the final terminating newline does NOT create
// a trailing empty record, and an empty file has ZERO records. awk's
// `print` uses ORS="\n": every printed record is emitted followed by "\n".
// =====================================================================

/**
 * Split text into records exactly the way awk's default `RS="\n"` does:
 *   - the empty string is ZERO records (an empty file: awk NR==0),
 *   - a single trailing newline is a terminator, not a separator, so it
 *     does NOT yield an extra empty final record ("a\n" → ["a"]),
 *   - interior/leading blank lines ARE records ("a\n\n" → ["a", ""]).
 */
export function splitAwkRecords(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  // Drop the single empty element the terminating newline leaves behind
  // (present iff the text ends in "\n"); interior blanks are preserved.
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * Join output records the way awk's `print` (ORS="\n") does: each record is
 * emitted followed by "\n". An empty list yields the empty string (awk that
 * prints nothing writes nothing — no stray newline).
 */
export function joinAwkLines(lines: readonly string[]): string {
  let out = "";
  for (const line of lines) out += line + "\n";
  return out;
}
