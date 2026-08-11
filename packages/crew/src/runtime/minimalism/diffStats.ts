// =====================================================================
// Diff-stats parser — strangler port of the awk in gaffer_diff_stats
// (runner/lib/minimalism.sh:26). Pure text-in → text-out: it turns the
// `git diff --numstat <base>...HEAD` output into the "<files> <lines>" pair the
// minimalism gate consumes. The git call itself stays in bash; this only parses.
//
// numstat rows are `<added>\t<deleted>\t<path>` (binary files render "-\t-\t…").
// Byte-identical to the awk:
//   { files++ }                         # every record is a file
//   $1 ~ /^[0-9]+$/ { added   += $1 }   # added lines when numeric (else binary "-")
//   $2 ~ /^[0-9]+$/ { deleted += $2 }
//   END { printf "%d %d\n", files, added+deleted }
// Fields use awk's default FS (any whitespace run), and records use awk RS='\n'
// (a terminating newline is NOT an extra empty record) — hence splitAwkRecords.
// =====================================================================

import { splitAwkRecords } from "../dod/awkText.js";

/** Parse `git diff --numstat` output into "<files> <lines>" (lines = added+deleted). */
export function diffStats(numstat: string): string {
  const records = splitAwkRecords(numstat);
  const files = records.length;
  let added = 0;
  let deleted = 0;
  for (const r of records) {
    const fields = r.trim().split(/\s+/);
    const a = fields[0] ?? "";
    const d = fields[1] ?? "";
    if (/^[0-9]+$/.test(a)) added += Number.parseInt(a, 10);
    if (/^[0-9]+$/.test(d)) deleted += Number.parseInt(d, 10);
  }
  return `${files} ${added + deleted}`;
}
