import { isAbsolute, relative } from "node:path";

import type { CommandRunner } from "../../adapters/commandRunner.js";
import { ORACLE_RUN_OPTIONS, safeJsonParse } from "./parse.js";
import { resolveBinary } from "./resolveBinary.js";
import type { Oracle, OracleFinding, OracleResult, OracleSeverity } from "./types.js";

/**
 * Security oracle backed by semgrep. Runs `semgrep --json --config <ruleset>`
 * over the repo and normalizes results into precise findings (file, line span,
 * check-id rule, severity, message). semgrep is treated as STRICTLY OPTIONAL:
 * when it isn't on PATH, the oracle reports `available: false` and the
 * security-hotspot loop falls back to its existing three-lens grep+verify path.
 *
 * The default ruleset is `auto` (semgrep's curated registry pack). An operator
 * can point this at a local ruleset directory/file instead. We never fetch over
 * the network ourselves — semgrep manages its own rule cache; `auto` may require
 * connectivity on first use, so a curated LOCAL ruleset is the safer default for
 * a fully offline factory (deferred: shipping a bundled ruleset).
 */

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: { message?: string; severity?: string };
}
interface SemgrepReport {
  results?: SemgrepResult[];
}

function severityFor(raw: string | undefined): OracleSeverity {
  switch ((raw ?? "").toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

/** Parse `semgrep --json` output into findings (defensive — never throws). */
export function parseSemgrepOutput(output: string, root: string): OracleFinding[] {
  const report = safeJsonParse<SemgrepReport>(output);
  if (!report || !Array.isArray(report.results)) return [];

  const findings: OracleFinding[] = [];
  for (const r of report.results) {
    if (!r || typeof r.path !== "string") continue;
    const line = typeof r.start?.line === "number" && r.start.line > 0 ? r.start.line : 1;
    const endLine = typeof r.end?.line === "number" && r.end.line > 0 ? r.end.line : undefined;
    findings.push({
      file: normalizeFile(r.path, root),
      line,
      ...(endLine !== undefined ? { endLine } : {}),
      rule: typeof r.check_id === "string" && r.check_id.length > 0 ? r.check_id : "semgrep",
      severity: severityFor(r.extra?.severity),
      message: (r.extra?.message ?? "Security finding").trim(),
    });
  }
  return findings;
}

function normalizeFile(file: string, root: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}

/**
 * Build the semgrep security oracle. `ruleset` is passed to `--config`
 * (default `auto`). Absent binary → unavailable so the loop keeps its heuristic
 * three-lens path. A non-zero exit (findings present) is still a successful run.
 */
export function createSecurityOracle(
  runner: CommandRunner,
  options: { binary?: string; ruleset?: string } = {},
): Oracle {
  const binary = options.binary ?? "semgrep";
  const ruleset = options.ruleset ?? "auto";
  return {
    id: "semgrep",
    consult(root: string): OracleResult {
      const resolved = resolveBinary(binary, root);
      if (!resolved) return { available: false, reason: `${binary} not found on PATH` };
      const result = runner.runArgs(
        resolved,
        ["--json", "--quiet", "--config", ruleset, "."],
        root,
        ORACLE_RUN_OPTIONS,
      );
      return { available: true, findings: parseSemgrepOutput(result.stdout, root) };
    },
  };
}
