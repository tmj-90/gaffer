import { isAbsolute, relative } from "node:path";

import type { CommandRunner } from "../../adapters/commandRunner.js";
import { ORACLE_RUN_OPTIONS, safeJsonParse } from "./parse.js";
import { resolveBinary } from "./resolveBinary.js";
import type { Oracle, OracleFinding, OracleResult, OracleSeverity } from "./types.js";

/**
 * Security oracle backed by semgrep. Runs `semgrep --json --config <ruleset>`
 * over the repo and normalizes results into precise findings (file, line span,
 * check-id rule, severity, message). semgrep is treated as STRICTLY OPTIONAL:
 * when it isn't on PATH — or when no ruleset is configured — the oracle reports
 * `available: false` and the security-hotspot loop falls back to its existing
 * three-lens grep+verify path.
 *
 * LOCAL-FIRST: the ruleset is NEVER defaulted to `auto`. semgrep's `auto` pulls
 * rules from the semgrep registry over the network on first use, which violates
 * the offline-by-default contract of a local factory. The ruleset must therefore
 * be configured explicitly, via `options.ruleset` or the `GAFFER_SEMGREP_RULESET`
 * env var (pointing at a local ruleset file/dir). With neither set the oracle is
 * unavailable — no semgrep is invoked — and the loop keeps its heuristic path.
 * (Deferred: shipping a curated bundled local ruleset as the documented default.)
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

/** Env var naming a LOCAL semgrep ruleset (file or dir) passed to `--config`. */
const RULESET_ENV = "GAFFER_SEMGREP_RULESET";

/** Env var that allows remote rulesets (opt-in). Disabled by default. */
const ALLOW_REMOTE_ENV = "GAFFER_SEMGREP_ALLOW_REMOTE";

/** True when the ruleset looks like a remote semgrep registry pack. */
function isRemoteRuleset(ruleset: string): boolean {
  return ruleset === "auto" || ruleset.startsWith("p/") || ruleset.startsWith("r/");
}

/**
 * Resolve the ruleset to pass to `--config`, LOCAL-FIRST. Precedence:
 * `options.ruleset` → `$GAFFER_SEMGREP_RULESET`. Whitespace is trimmed and an
 * empty value is treated as unset. Returns `undefined` when nothing is
 * configured — the oracle is then unavailable rather than silently falling back
 * to the network `auto` pack. `auto` is never used as a default.
 */
function resolveRuleset(
  optionRuleset: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromOption = (optionRuleset ?? "").trim();
  if (fromOption !== "") return fromOption;
  const fromEnv = (env[RULESET_ENV] ?? "").trim();
  return fromEnv !== "" ? fromEnv : undefined;
}

/**
 * Build the semgrep security oracle. The ruleset passed to `--config` comes from
 * `options.ruleset` or `$GAFFER_SEMGREP_RULESET` — never the network `auto` pack.
 * Unavailable (so the loop keeps its heuristic three-lens path) when EITHER the
 * binary is absent OR no ruleset is configured. A non-zero exit (findings
 * present) is still a successful run.
 */
export function createSecurityOracle(
  runner: CommandRunner,
  options: { binary?: string; ruleset?: string; env?: NodeJS.ProcessEnv } = {},
): Oracle {
  const binary = options.binary ?? "semgrep";
  const env = options.env ?? process.env;
  const ruleset = resolveRuleset(options.ruleset, env);
  return {
    id: "semgrep",
    consult(root: string): OracleResult {
      // Local-first: refuse to run without an explicit local ruleset rather than
      // defaulting to semgrep's network `auto` pack. Checked BEFORE resolving the
      // binary so no semgrep process is ever spawned when unconfigured.
      if (ruleset === undefined) {
        return {
          available: false,
          reason: `semgrep ruleset not configured (set ${RULESET_ENV} to a local ruleset)`,
        };
      }
      // Offline-by-default: reject remote registry packs unless the operator
      // explicitly opts in via GAFFER_SEMGREP_ALLOW_REMOTE=1.
      if (isRemoteRuleset(ruleset) && (env[ALLOW_REMOTE_ENV] ?? "").trim() !== "1") {
        return {
          available: false,
          reason: `semgrep ruleset '${ruleset}' looks like a remote registry pack (auto/p//r/); set ${ALLOW_REMOTE_ENV}=1 to allow remote rulesets`,
        };
      }
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
