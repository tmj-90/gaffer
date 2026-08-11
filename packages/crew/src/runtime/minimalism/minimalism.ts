// =====================================================================
// Minimalism post-condition — strangler port of runner/lib/minimalism.sh's
// gaffer_check_minimalism (P4; a delivery gate DECISION, pure). Given a
// completed delivery's diff size + smallest-change note, it returns ONE verdict
// token, a return CODE, and a human REASON — byte-identical to the bash.
//
//   ok             — note present, diff within caps                 code 0
//   missing_note   — no smallest-change note (whitespace-only = missing)
//                    → enforce ? code 1 : code 2
//   unverified_note— note references NONE of the changed files      code 2
//   oversized_diff — note present but over a size cap (flag, not fail) code 2
//
// PURE: every input is pre-computed by the caller (diff stats come from
// gaffer_diff_stats' git call, which stays in bash). This module only decides.
// The note excerpt in the unverified reason is byte-oriented (cut -c under LC=C).
// =====================================================================

export interface MinimalismInput {
  files: number;
  lines: number;
  note: string;
  /** Space/tab/newline-separated changed-file list; "" skips the relevance check. */
  changed?: string;
  /** OVERSIZED_MAX_LINES (default 400); 0 disables the lines dimension. */
  maxLines?: number;
  /** OVERSIZED_MAX_FILES (default 12); 0 disables the files dimension. */
  maxFiles?: number;
  /** MINIMALISM_ENFORCE (default true): a missing note fails (code 1) vs flags (2). */
  enforce?: boolean;
}

export interface MinimalismVerdict {
  verdict: "ok" | "missing_note" | "unverified_note" | "oversized_diff";
  code: number;
  reason: string;
}

/** ASCII-only lowercase, matching the bash `tr 'A-Z' 'a-z'` (byte, not Unicode). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Last path segment, matching coreutils `basename` for our (no-trailing-slash) paths. */
function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Assess a delivery against the minimalism post-condition. Mirrors
 * gaffer_check_minimalism line-for-line (verdict token, return code, reason text).
 */
export function checkMinimalism(input: MinimalismInput): MinimalismVerdict {
  const { files, lines, note } = input;
  const changed = input.changed ?? "";
  const maxLines = input.maxLines ?? 400;
  const maxFiles = input.maxFiles ?? 12;
  const enforce = input.enforce ?? true;

  // Smallest-change note is MANDATORY; whitespace-only (POSIX [:space:]) = missing.
  const trimmed = note.replace(/[ \t\n\v\f\r]/g, "");
  if (trimmed === "") {
    const reason = "missing smallest-change note (required for every completed delivery)";
    return { verdict: "missing_note", code: enforce ? 1 : 2, reason };
  }

  // Relevance: a note referencing NONE of the changed files looks like boilerplate.
  if (changed !== "") {
    const noteLc = asciiLower(note);
    let referenced = false;
    for (const f of changed.split(/[ \t\n]+/)) {
      if (f === "") continue;
      const bn = asciiLower(basename(f));
      if (bn === "") continue;
      if (noteLc.includes(bn)) {
        referenced = true;
        break;
      }
      const dot = bn.lastIndexOf(".");
      const stem = dot >= 0 ? bn.slice(0, dot) : bn;
      if (stem.length >= 4 && noteLc.includes(stem)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      // `printf %s "$note" | tr -d '\n' | cut -c1-80` — strip newlines, first 80
      // chars. (cut -c is byte-oriented under LC_ALL=C; for the ASCII English notes
      // agents write these coincide — a multibyte char straddling byte 80 is the
      // only divergence, harmless in a flag reason.)
      const excerpt = note.replace(/\n/g, "").slice(0, 80);
      const reason = `smallest-change note references no changed file (possible boilerplate): "${excerpt}"`;
      return { verdict: "unverified_note", code: 2, reason };
    }
  }

  // Oversized diff → flag (never fail). A cap of 0 disables that dimension.
  if ((maxLines > 0 && lines > maxLines) || (maxFiles > 0 && files > maxFiles)) {
    const reason = `oversized_diff: ${files} files / ${lines} lines (caps: ${maxFiles} files / ${maxLines} lines) — suggest a split`;
    return { verdict: "oversized_diff", code: 2, reason };
  }

  const reason = `minimal: ${files} files / ${lines} lines within caps; smallest-change note present`;
  return { verdict: "ok", code: 0, reason };
}
