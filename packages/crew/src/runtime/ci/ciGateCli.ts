#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the CI-gate check-status parse (P3/P4). The typed seam
// target for runner/lib/ci-gate.sh's gaffer_parse_checks: it reads the checks
// table on STDIN and writes the verdict to STDOUT with NO trailing byte (the
// bash uses `printf` without a newline), so the `$( … )` capture is byte-identical.
//
//   printf '%s' "$checks_output" | node ciGateCli.js parse-checks
//
// Imports only ./parseChecks.js. FAIL-SOFT bias for the wiring: on a thrown error
// it exits non-zero so the bash seam falls back to its awk (a CI verdict is never
// silently lost); on success it exits 0 with the verdict on stdout.
// =====================================================================

import { readFileSync } from "node:fs";

import { parseChecks } from "./parseChecks.js";

try {
  const mode = process.argv[2] ?? "";
  if (mode !== "parse-checks") {
    process.stderr.write(`ci-gate: unknown mode "${mode}" (expected: parse-checks)\n`);
    process.exit(2);
  }
  // process.stdout.write (NOT console.log) — no trailing newline, matching the
  // bash `printf '%s'` the caller captures with `$( … )`.
  process.stdout.write(parseChecks(readFileSync(0, "utf8")));
} catch (err) {
  process.stderr.write(`ci-gate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
