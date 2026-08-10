import { joinAwkLines, splitAwkRecords } from "./awkText.js";

// =====================================================================
// DoD failure-extractor — TS port of `gaffer_dod_extract_failure`'s awk
// (runner/lib/dod.sh). Pulls the DISTILLED real-failure text back out of a
// results file's framed `---DOD-OUTPUT gate@repo--- … ---END-DOD-OUTPUT---`
// block(s) for feeding the NEXT rework attempt (the REVIEW FEEDBACK block).
// ---------------------------------------------------------------------
// PARITY: a byte-for-byte port of the awk.
//   - Open frame: a line matching `^---DOD-OUTPUT ` (note the trailing space
//     in the marker). Strip the `---DOD-OUTPUT ` prefix and a trailing `---`
//     (with optional trailing whitespace), emit `failing gate: <h>`, keep=1.
//   - Close frame: a line matching `^---END-DOD-OUTPUT---` → keep=0.
//   - Body: while keeping and the line is non-blank → emit `"  " + line`
//     (exactly two spaces of indent).
// Multiple frames are supported; nothing is emitted when there is no frame.
// Proven byte-identical by runner/test/dod-distill-parity.test.sh.
//
// All markers here are pure ASCII, so (unlike distillOutput) no byte/Unicode
// distinction arises in the matching; body lines are copied through verbatim.
// The caller still passes the latin1 BYTE view (see dodDistillCli.ts) so those
// body bytes are preserved 1:1, byte-identical to the awk.
//
// Pure bytes-in / bytes-out (no I/O) so it unit-tests trivially.
// =====================================================================

// awk `/^---DOD-OUTPUT /` — the open marker (matches as a PREFIX; the trailing
// space is significant). Reused for the `sub()` prefix strip: a non-global
// regex carries no lastIndex state across .test()/.replace().
const OPEN_FRAME = /^---DOD-OUTPUT /;
// awk `sub(/---[ \t]*$/,"",h)` — strip a trailing `---` plus optional trailing
// whitespace (present when the marker is `…gate@repo---`).
const OPEN_SUFFIX = /---[ \t]*$/;
// awk `/^---END-DOD-OUTPUT---/` — the close marker (matches as a PREFIX).
const CLOSE_FRAME = /^---END-DOD-OUTPUT---/;
// awk `/^[ \t]*$/` — a line that is empty or only spaces/tabs.
const BLANK_LINE = /^[ \t]*$/;

/**
 * Extract the framed failure block(s) from a DoD results file's text.
 *
 * @param text the results-file contents, verbatim.
 * @returns the extracted feedback lines joined awk-style (each line + "\n");
 *   the empty string when the results carried no failing block.
 */
export function extractFailure(text: string): string {
  const lines = splitAwkRecords(text);
  const out: string[] = [];
  let keep = false;

  for (const raw of lines) {
    if (OPEN_FRAME.test(raw)) {
      const header = raw.replace(OPEN_FRAME, "").replace(OPEN_SUFFIX, "");
      out.push("failing gate: " + header);
      keep = true;
      continue;
    }
    if (CLOSE_FRAME.test(raw)) {
      keep = false;
      continue;
    }
    if (keep && !BLANK_LINE.test(raw)) {
      out.push("  " + raw);
    }
  }

  return joinAwkLines(out);
}
