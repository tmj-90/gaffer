import { isAbsolute, relative } from "node:path";

import type { CommandRunner } from "../../adapters/commandRunner.js";
import { ORACLE_RUN_OPTIONS } from "./parse.js";
import { resolveBinary } from "./resolveBinary.js";
import type { Oracle, OracleFinding, OracleResult } from "./types.js";

/**
 * tsc oracle. Runs `tsc --noEmit --pretty false` and parses the diagnostic lines
 * into precise type findings (file, line, `TSxxxx` rule, severity, message). This
 * replaces the type-quality loop's line-based `any`/`as`/`!` heuristics with the
 * type-checker's own verdict when TypeScript is installed.
 *
 * tsc emits no machine-readable JSON, so we parse its stable line format:
 *   `path/to/file.ts(LINE,COL): error TS2345: message`
 * `--pretty false` guarantees this one-line-per-diagnostic shape (no colour, no
 * code frames). A non-zero exit is EXPECTED (type errors exit 1/2); we parse
 * whatever diagnostics appear regardless of exit code.
 */

const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** Map a tsc diagnostic line to a finding, or `undefined` if it isn't one. */
export function parseTscLine(line: string, root: string): OracleFinding | undefined {
  const m = DIAGNOSTIC_RE.exec(line.trimEnd());
  if (!m) return undefined;
  const [, rawFile, lineNo, , kind, code, message] = m;
  return {
    file: normalizeFile(rawFile!, root),
    line: Number(lineNo),
    rule: code!,
    severity: kind === "warning" ? "warning" : "error",
    message: message!.trim(),
  };
}

/** Parse the full `tsc --pretty false` output into findings (defensive). */
export function parseTscOutput(output: string, root: string): OracleFinding[] {
  const findings: OracleFinding[] = [];
  for (const line of output.split("\n")) {
    const finding = parseTscLine(line, root);
    if (finding) findings.push(finding);
  }
  return findings;
}

function normalizeFile(file: string, root: string): string {
  const trimmed = file.trim();
  return isAbsolute(trimmed) ? relative(root, trimmed) : trimmed;
}

/**
 * Build the tsc oracle. `binary` defaults to `tsc`, resolved on PATH (or repo
 * `node_modules/.bin`) at consult time. Absent tool → `available: false`.
 */
export function createTscOracle(runner: CommandRunner, binary = "tsc"): Oracle {
  return {
    id: "tsc",
    consult(root: string): OracleResult {
      const resolved = resolveBinary(binary, root);
      if (!resolved) return { available: false, reason: `${binary} not found on PATH` };
      const result = runner.runArgs(
        resolved,
        ["--noEmit", "--pretty", "false"],
        root,
        ORACLE_RUN_OPTIONS,
      );
      // tsc exits non-zero when it finds type errors — that's a SUCCESSFUL run,
      // not a tool failure. We parse the diagnostics from stdout regardless.
      return { available: true, findings: parseTscOutput(result.stdout, root) };
    },
  };
}
