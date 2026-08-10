import { joinAwkLines, splitAwkRecords } from "./awkText.js";

// =====================================================================
// DoD failure-distiller — TS port of `gaffer_dod_distill_output`'s awk
// (runner/lib/dod.sh). Distils the ACTUAL failure from a gate command's
// raw output — the failing test name(s) + the assertion/error/stack lines
// — NOT a blind tail or the framework's summary count line.
// ---------------------------------------------------------------------
// PARITY: this is a byte-for-byte port of the awk. The thirteen signal
// regexes are ported verbatim (same order, same anchors, same case
// sensitivity). awk `~` is an UNANCHORED partial match, so each pattern is
// used as-is with RegExp.test() (no added ^/$). The MAX cap, the file-order
// signal emission, the last-MAX-lines tail fallback for the no-signal case,
// and the non-blank filtering all mirror the awk END block exactly. Proven
// byte-identical by runner/test/dod-distill-parity.test.sh.
//
// BYTE SEMANTICS (load-bearing): the runner's awk is **mawk**, which is NOT
// UTF-8 aware in ANY locale — it matches regexes against RAW BYTES. So the
// two multibyte patterns below are ported as their exact UTF-8 BYTE forms,
// and the caller MUST pass `text` as the file's bytes decoded 1:1 to chars
// (Node "latin1"), NOT as a decoded Unicode string. Consequences that are
// FAITHFUL to the live awk, not bugs to "fix":
//   - `[✕✗×]` is a BYTE class: its members are the individual UTF-8 bytes of
//     ✕(E2 9C 95) ✗(E2 9C 97) ×(C3 97) → {95,97,9C,C3,E2}. A line therefore
//     matches when it contains ANY of those bytes — including unrelated
//     multibyte glyphs that share a byte (e.g. vitest's `❯` = E2 9D AF, which
//     shares 0xE2). mawk keeps those lines; so does this port.
//   - `● ` (jest) is the literal 3-byte sequence E2 97 8F followed by a space.
// The other eleven patterns are pure ASCII, so byte and code-point matching
// coincide for them.
//
// Pure bytes-in / bytes-out (no I/O) so it unit-tests trivially and the live
// entrypoint (dodDistillCli.ts) is a thin fail-soft latin1 wrapper around it.
// =====================================================================

// The thirteen signal patterns, ported VERBATIM from the awk `is_signal()`
// (same order, same regexes) over the latin1 BYTE view (see header). Reused
// across lines via RegExp.test(), which does not touch lastIndex for a
// non-global regex — so they carry no state.
const SIGNAL_PATTERNS: readonly RegExp[] = [
  /--- FAIL:/, //                              go test
  /(^|[ \t])FAILED([ \t]|:|$)/, //             pytest / gradle
  /(^|[ \t])FAIL([ \t]|:|$)/, //               vitest / jest / go
  /[\x95\x97\x9C\xC3\xE2]/, //                  vitest / jest marks [✕✗×] as mawk BYTES
  /(^|[ \t])\xE2\x97\x8F /, //                  jest failing block: `● ` (E2 97 8F + space)
  /AssertionError|Assertion/,
  /[Ee]xpected|[Rr]eceived|but was|but got|actual:/,
  /[A-Za-z_.]*(Error|Exception)(:| |$)/, //     FooError: / Exception
  /panic:/, //                                  go
  /Traceback|(^|[ \t])E[ \t]/, //              pytest error lines
  /\[ERROR\]|<<< (FAILURE|ERROR)/, //          maven surefire
  /(^|[ \t])assert/,
  /:[0-9]+:[0-9]+|:[0-9]+\)/, //               file:line stack refs
];

// awk `/^[ \t]*$/` — a line that is empty or only spaces/tabs.
const BLANK_LINE = /^[ \t]*$/;

/**
 * True when a line carries real failure signal — the port of the awk
 * `is_signal()`. Deliberately broad (best-effort): a false positive keeps
 * one extra line; a false negative is covered by the tail fallback.
 */
export function isSignalLine(s: string): boolean {
  for (const pattern of SIGNAL_PATTERNS) {
    if (pattern.test(s)) return true;
  }
  return false;
}

/**
 * Distil the failure evidence from raw gate output.
 *
 * @param text raw gate-command output (as read from the file, verbatim).
 * @param max  the hard cap on emitted lines (awk `MAX`). The caller resolves
 *   it (arg → GAFFER_DOD_FEEDBACK_LINES → GAFFER_DOD_OUTPUT_TAIL → 40).
 * @returns the distilled lines joined awk-style (each line + "\n"); the empty
 *   string when nothing is emitted (empty input, or an all-blank tail window).
 */
export function distillOutput(text: string, max: number): string {
  const lines = splitAwkRecords(text);
  const nr = lines.length;

  // Pass 1: mark the signal lines (signal AND non-blank), awk's main rule.
  const sig = new Array<boolean>(nr).fill(false);
  let nsig = 0;
  for (let i = 0; i < nr; i += 1) {
    const s = lines[i]!;
    if (isSignalLine(s) && !BLANK_LINE.test(s)) {
      sig[i] = true;
      nsig += 1;
    }
  }

  // Pass 2: awk END block — signal lines in file order (capped at MAX), else
  // the last MAX lines skipping blanks (which can yield FEWER than MAX lines).
  const selected: string[] = [];
  if (nsig > 0) {
    let c = 0;
    for (let i = 0; i < nr && c < max; i += 1) {
      if (sig[i]) {
        selected.push(lines[i]!);
        c += 1;
      }
    }
  } else {
    // awk: start = NR-MAX+1 (1-based), clamped to >=1. 0-based: NR-MAX, >=0.
    let start = nr - max;
    if (start < 0) start = 0;
    for (let i = start; i < nr; i += 1) {
      const s = lines[i]!;
      if (!BLANK_LINE.test(s)) selected.push(s);
    }
  }

  return joinAwkLines(selected);
}
