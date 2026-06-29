import { isAbsolute, relative } from "node:path";

import type { CommandRunner } from "../../adapters/commandRunner.js";
import { ORACLE_RUN_OPTIONS, safeJsonParse } from "./parse.js";
import { resolveBinary } from "./resolveBinary.js";
import type { Oracle, OracleFinding, OracleResult } from "./types.js";

/**
 * Dead-code oracle. Prefers `knip` (richer: unused files, exports, dependencies),
 * falling back to `ts-prune` (unused exports only) when knip isn't installed.
 * Either way the output is normalized to `unused-*` findings the tech-debt loop
 * can draft against. Both tools are OPTIONAL — neither present → unavailable.
 */

// ── knip JSON ───────────────────────────────────────────────────────────────
// `knip --reporter json` shape (subset we consume):
//   { "files": ["unused/file.ts"], "issues": [ { "file": "x.ts",
//     "exports": [ { "name": "foo", "line": 12 } ], ... } ] }

interface KnipExportIssue {
  name?: string;
  line?: number;
}
interface KnipIssue {
  file?: string;
  exports?: KnipExportIssue[];
  types?: KnipExportIssue[];
}
interface KnipReport {
  files?: string[];
  issues?: KnipIssue[];
}

export function parseKnipOutput(output: string, root: string): OracleFinding[] {
  const report = safeJsonParse<KnipReport>(output);
  if (!report || typeof report !== "object") return [];
  const findings: OracleFinding[] = [];

  for (const file of Array.isArray(report.files) ? report.files : []) {
    if (typeof file !== "string") continue;
    findings.push({
      file: normalizeFile(file, root),
      line: 1,
      rule: "unused-file",
      severity: "warning",
      message: "File is unused (no imports reach it).",
    });
  }

  for (const issue of Array.isArray(report.issues) ? report.issues : []) {
    if (!issue || typeof issue.file !== "string") continue;
    const rel = normalizeFile(issue.file, root);
    for (const group of [issue.exports, issue.types]) {
      for (const exp of Array.isArray(group) ? group : []) {
        if (!exp || typeof exp.name !== "string") continue;
        findings.push({
          file: rel,
          line: typeof exp.line === "number" && exp.line > 0 ? exp.line : 1,
          rule: "unused-export",
          severity: "warning",
          message: `Unused export \`${exp.name}\`.`,
        });
      }
    }
  }
  return findings;
}

// ── ts-prune text ─────────────────────────────────────────────────────────────
// Lines like: `src/foo.ts:12 - bar` (optionally `(used in module)` suffix, which
// we drop — those aren't truly dead).

const TS_PRUNE_RE = /^(.+?):(\d+)\s+-\s+(.+?)(?:\s+\(used in module\))?$/;

export function parseTsPruneOutput(output: string, root: string): OracleFinding[] {
  const findings: OracleFinding[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Drop "(used in module)" rows — re-exported-but-locally-used isn't dead.
    if (/\(used in module\)\s*$/.test(line)) continue;
    const m = TS_PRUNE_RE.exec(line);
    if (!m) continue;
    findings.push({
      file: normalizeFile(m[1]!, root),
      line: Number(m[2]),
      rule: "unused-export",
      severity: "warning",
      message: `Unused export \`${m[3]!.trim()}\`.`,
    });
  }
  return findings;
}

function normalizeFile(file: string, root: string): string {
  const trimmed = file.trim();
  return isAbsolute(trimmed) ? relative(root, trimmed) : trimmed;
}

/**
 * Build the dead-code oracle. Resolves `knip` first, then `ts-prune`. Neither
 * present → unavailable (loop falls back to its heuristic). Tool exit codes are
 * ignored (knip/ts-prune exit non-zero WHEN they find dead code); we parse output.
 */
export function createDeadCodeOracle(
  runner: CommandRunner,
  binaries: { knip?: string; tsPrune?: string } = {},
): Oracle {
  const knipName = binaries.knip ?? "knip";
  const tsPruneName = binaries.tsPrune ?? "ts-prune";
  return {
    id: "dead_code",
    consult(root: string): OracleResult {
      const knip = resolveBinary(knipName, root);
      if (knip) {
        const result = runner.runArgs(knip, ["--reporter", "json"], root, ORACLE_RUN_OPTIONS);
        return { available: true, findings: parseKnipOutput(result.stdout, root) };
      }
      const tsPrune = resolveBinary(tsPruneName, root);
      if (tsPrune) {
        const result = runner.runArgs(tsPrune, [], root, ORACLE_RUN_OPTIONS);
        return { available: true, findings: parseTsPruneOutput(result.stdout, root) };
      }
      return { available: false, reason: "neither knip nor ts-prune found on PATH" };
    },
  };
}
