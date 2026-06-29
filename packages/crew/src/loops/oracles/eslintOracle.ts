import { isAbsolute, relative } from "node:path";

import type { CommandRunner } from "../../adapters/commandRunner.js";
import { ORACLE_RUN_OPTIONS, safeJsonParse } from "./parse.js";
import { resolveBinary } from "./resolveBinary.js";
import type { Oracle, OracleFinding, OracleResult, OracleSeverity } from "./types.js";

/**
 * ESLint oracle. Runs `eslint --format json .` and parses the structured report
 * into precise findings (file, line, rule, severity, message). Replaces the
 * tech-debt loop's grep heuristics with the linter's own complexity / unused /
 * quality verdicts when ESLint is installed and configured. Whatever rules the
 * repo's own config enables are what we surface — including any security-plugin
 * rules (e.g. `security/*`), which the loop can route to the security lane.
 */

/** One message in an ESLint JSON file report. */
interface EslintMessage {
  ruleId: string | null;
  severity: number; // 1 = warning, 2 = error
  line?: number;
  endLine?: number;
  message: string;
}

/** One file entry in an ESLint JSON report. */
interface EslintFileReport {
  filePath: string;
  messages?: EslintMessage[];
}

function severityFor(n: number): OracleSeverity {
  return n >= 2 ? "error" : "warning";
}

/** Parse `eslint --format json` output into findings (defensive — never throws). */
export function parseEslintOutput(output: string, root: string): OracleFinding[] {
  const report = safeJsonParse<EslintFileReport[]>(output);
  if (!Array.isArray(report)) return [];

  const findings: OracleFinding[] = [];
  for (const file of report) {
    if (!file || typeof file.filePath !== "string" || !Array.isArray(file.messages)) continue;
    const rel = normalizeFile(file.filePath, root);
    for (const msg of file.messages) {
      if (!msg || typeof msg.message !== "string") continue;
      // A null line (parse-level error) is pinned to line 1 so it stays locatable.
      const line = typeof msg.line === "number" && msg.line > 0 ? msg.line : 1;
      findings.push({
        file: rel,
        line,
        ...(typeof msg.endLine === "number" ? { endLine: msg.endLine } : {}),
        rule: msg.ruleId ?? "eslint",
        severity: severityFor(msg.severity),
        message: msg.message.trim(),
      });
    }
  }
  return findings;
}

function normalizeFile(file: string, root: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}

/**
 * Build the ESLint oracle. Runs the linter over `.` (the repo root) in JSON
 * format. A missing binary → `available: false`; a non-zero exit (lint errors
 * present) is a successful run we still parse.
 */
export function createEslintOracle(runner: CommandRunner, binary = "eslint"): Oracle {
  return {
    id: "eslint",
    consult(root: string): OracleResult {
      const resolved = resolveBinary(binary, root);
      if (!resolved) return { available: false, reason: `${binary} not found on PATH` };
      const result = runner.runArgs(
        resolved,
        ["--format", "json", "--no-color", "."],
        root,
        ORACLE_RUN_OPTIONS,
      );
      return { available: true, findings: parseEslintOutput(result.stdout, root) };
    },
  };
}
