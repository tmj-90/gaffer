#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the delivery-hygiene forbidden-path scan (P4).
// The LIVE seam target: gaffer_assert_clean_delivery routes its per-path
// forbidden-fragment loop through this CLI when GAFFER_RUNTIME=ts and this
// dist bin exists, else it runs the legacy bash `case`-glob loop verbatim.
//
//   printf '%s\n' "$changed_paths" | node hygieneCli.js forbidden
//
// Reads the changed diff paths on STDIN (one per line) and the policy from
// env HYGIENE_FORBIDDEN_PATHS (same default as the bash), and writes ONE
// "forbidden path in delivery diff: <path>" line per forbidden path — byte-
// identical to what the bash loop appends. BATCH by design: one node spawn for
// the whole diff, not one per path.
//
// FAIL-CLOSED bias: this is a SAFETY gate, so a thrown error is reported to
// stderr and exits non-zero — the caller must treat a scan it cannot complete
// as a gate failure, never a silent pass. (The bash caller keeps its own path
// list, so on a non-zero exit it can fall back to the legacy loop.)
// =====================================================================

import { readFileSync } from "node:fs";

import { DEFAULT_FORBIDDEN_PATHS, isForbiddenPath, parseFragments } from "./forbiddenPath.js";

try {
  const mode = process.argv[2] ?? "";
  if (mode !== "forbidden") {
    process.stderr.write(`hygiene: unknown mode "${mode}" (expected: forbidden)\n`);
    process.exit(2);
  }
  const fragments = parseFragments(process.env.HYGIENE_FORBIDDEN_PATHS ?? DEFAULT_FORBIDDEN_PATHS);
  const stdin = readFileSync(0, "utf8");
  const out: string[] = [];
  for (const path of stdin.split("\n")) {
    if (path === "") continue; // matches the bash `[ -n "$path" ] || continue`
    if (isForbiddenPath(path, fragments)) out.push(`forbidden path in delivery diff: ${path}`);
  }
  // Newline-terminated lines (each bash `violations+=…$'\n'`); nothing when clean.
  if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
} catch (err) {
  process.stderr.write(`hygiene: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
