#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the DoD failure distill / extract text-processors
// (strangler port of runner/lib/dod.sh's two awk helpers). This is the
// LIVE seam target: dod.sh routes `gaffer_dod_distill_output` and
// `gaffer_dod_extract_failure` through this CLI when GAFFER_DOD_DISTILL=ts
// and this dist bin exists, otherwise it runs the legacy awk verbatim.
//
// Mirrors renderMcpCli.ts's discipline: it imports ONLY the two pure
// modules (./distillOutput.js, ./extractFailure.js) — no CLI framework,
// no zod — so startup stays fast and side-effect-free, and the unit-tested
// pure function IS the live behaviour.
//
// CONTRACT (paths on argv, mode as the first token):
//   node dodDistillCli.js distill --in <path> [--max <n>]
//   node dodDistillCli.js extract --in <path>
// The distilled/extracted text is written to STDOUT with no added byte
// (process.stdout.write of a latin1 Buffer, NOT console.log) so it is
// byte-identical to the awk `print` output the bash seam redirects with `>>`
// (proven by runner/test/dod-distill-parity.test.sh).
//
// BYTES, NOT UNICODE: the runner's awk is mawk, which matches raw bytes (see
// distillOutput.ts). So the input file is read as "latin1" (bytes decoded 1:1
// to chars) and the result written back as a "latin1" Buffer — the pure
// functions then see, and preserve, exactly the bytes mawk would.
//
// MAX resolution (distill only): --max arg → GAFFER_DOD_FEEDBACK_LINES →
// GAFFER_DOD_OUTPUT_TAIL → 40; an empty / non-numeric value coerces to 40.
//
// FAIL-SOFT (UNLIKE the fail-CLOSED render seam): distill/extract are
// best-effort feedback that decorates the evidence block — they are NEVER a
// gate and must NEVER fail a tick. So a missing/unreadable file, a bad mode,
// or any thrown error prints NOTHING and exits 0 — exactly like the awk's
// `[ -f "$infile" ] || return 0` and its `2>/dev/null`.
// =====================================================================

import { readFileSync } from "node:fs";

import { distillOutput } from "./distillOutput.js";
import { extractFailure } from "./extractFailure.js";

/** Resolve MAX exactly as the bash/awk chain does; coerce empty/NaN to 40. */
function resolveMax(argMax: string | undefined, env: NodeJS.ProcessEnv): number {
  const raw = argMax ?? env.GAFFER_DOD_FEEDBACK_LINES ?? env.GAFFER_DOD_OUTPUT_TAIL ?? "40";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 40;
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv[0] ?? "";

  let inPath = "";
  let argMax: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") {
      inPath = argv[(i += 1)] ?? "";
    } else if (arg === "--max") {
      argMax = argv[(i += 1)] ?? "";
    }
  }

  // No input path → nothing to do (print nothing, exit 0).
  if (!inPath) return;

  // File missing / unreadable → print nothing (awk: `[ -f ] || return 0`).
  // "latin1" decodes each byte to one char, so the pure functions match mawk's
  // byte-oriented regexes and preserve every byte verbatim.
  let text: string;
  try {
    text = readFileSync(inPath, "latin1");
  } catch {
    return;
  }

  let result: string;
  if (mode === "distill") {
    result = distillOutput(text, resolveMax(argMax, process.env));
  } else if (mode === "extract") {
    result = extractFailure(text);
  } else {
    return; // unknown mode → print nothing, exit 0.
  }

  // process.stdout.write of a latin1 Buffer — NOT console.log, and NOT a UTF-8
  // string: no byte may be re-encoded or appended, so the output stays
  // byte-identical to the awk `print` output the seam redirects.
  process.stdout.write(Buffer.from(result, "latin1"));
}

try {
  main();
} catch {
  // FAIL-SOFT: distill/extract are best-effort feedback, NEVER a gate — any
  // error prints nothing and exits 0, exactly like the awk's `2>/dev/null`.
}
