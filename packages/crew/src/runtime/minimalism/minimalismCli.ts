#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the minimalism post-condition decision (P4). This is the
// typed seam target for runner/lib/minimalism.sh's gaffer_check_minimalism; it
// lands FIRST (entrypoint proven byte-identical to the bash), before any live
// tick.sh wiring — exactly how renderPromptCli / renderMcpCli did.
//
//   printf '%s' "$note" | node minimalismCli.js --files <n> --lines <n> [--changed "<list>"]
//
// The note arrives on STDIN (it is free-form multi-line text — stdin avoids any
// argv/shell-escaping risk). Diff stats + the changed-file list are argv; the
// caps + enforce flag are read from the env (OVERSIZED_MAX_LINES / _FILES /
// MINIMALISM_ENFORCE), same names + defaults as the bash.
//
// OUTPUT — three lines, matching the bash's THREE observable outputs so a caller
// can reproduce all of them:
//   line 1  the verdict token   (bash: echoed to stdout)
//   line 2  the return code      (bash: the function's exit status)
//   line 3  the reason           (bash: GAFFER_MINIMALISM_REASON)
// The reason is written as a latin1 Buffer (byte-preserving) so the note excerpt
// stays byte-identical to the bash `cut -c` output.
// =====================================================================

import { readFileSync } from "node:fs";

import { checkMinimalism } from "./minimalism.js";

function flag(argv: string[], name: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? "";
  }
  return "";
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

try {
  const argv = process.argv.slice(2);
  const note = readFileSync(0, "utf8"); // stdin — the free-form note
  const v = checkMinimalism({
    files: intOr(flag(argv, "--files"), 0),
    lines: intOr(flag(argv, "--lines"), 0),
    note,
    changed: flag(argv, "--changed"),
    maxLines: intOr(process.env.OVERSIZED_MAX_LINES, 400),
    maxFiles: intOr(process.env.OVERSIZED_MAX_FILES, 12),
    enforce: (process.env.MINIMALISM_ENFORCE ?? "1") === "1",
  });
  // token + code + reason, each on its own line (reason as UTF-8 — it may carry
  // the em-dash in the oversized-diff reason; the reason never contains a newline).
  process.stdout.write(`${v.verdict}\n${v.code}\n${v.reason}\n`);
} catch (err) {
  process.stderr.write(`minimalism: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
}
