import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  applyScanFinding,
  finalizeScan,
  repoCandidates,
  safeRead,
  shouldSkipForReadyTickets,
  type IdleScanOutcome,
} from "./idleScans.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import { resolveMinDeliveredTickets, type RepoConfig } from "../config/schema.js";

const LOOP = "dependency_hygiene";

export interface DependencyFinding {
  kind: "outdated" | "vulnerable" | "pinned_floating";
  detail: string;
}

/**
 * Parse `pnpm/npm outdated --json` style output into outdated findings. Shape:
 * `{ "pkg": { "current": "1.0.0", "latest": "2.0.0", ... } }`. Best-effort —
 * unrecognised output yields nothing.
 */
export function parseOutdated(output: string): DependencyFinding[] {
  const json = tryParseJson(output);
  if (!json || typeof json !== "object") return [];
  const findings: DependencyFinding[] = [];
  for (const [pkg, infoRaw] of Object.entries(json as Record<string, unknown>)) {
    if (!infoRaw || typeof infoRaw !== "object") continue;
    const info = infoRaw as { current?: unknown; latest?: unknown; wanted?: unknown };
    const current = typeof info.current === "string" ? info.current : "?";
    const latest = typeof info.latest === "string" ? info.latest : "?";
    if (current !== latest) {
      findings.push({ kind: "outdated", detail: `${pkg}: ${current} → ${latest}` });
    }
  }
  return findings;
}

/**
 * Parse `npm audit --json` / `pnpm audit --json` advisory output into vulnerable
 * findings. Recognises the `metadata.vulnerabilities` summary block.
 */
export function parseAudit(output: string): DependencyFinding[] {
  const json = tryParseJson(output);
  if (!json || typeof json !== "object") return [];
  const meta = (json as { metadata?: { vulnerabilities?: Record<string, unknown> } }).metadata;
  const vulns = meta?.vulnerabilities;
  if (!vulns) return [];
  const findings: DependencyFinding[] = [];
  for (const [severity, countRaw] of Object.entries(vulns)) {
    const count = typeof countRaw === "number" ? countRaw : 0;
    if (count > 0 && severity !== "info") {
      findings.push({ kind: "vulnerable", detail: `${count} ${severity}-severity advisory(ies)` });
    }
  }
  return findings;
}

/** Flag wildcard/floating version ranges in package.json (a hygiene smell). */
export function scanPackageJson(text: string): DependencyFinding[] {
  const json = tryParseJson(text);
  if (!json || typeof json !== "object") return [];
  const findings: DependencyFinding[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = (json as Record<string, unknown>)[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [pkg, rangeRaw] of Object.entries(deps as Record<string, unknown>)) {
      const range = String(rangeRaw);
      if (range === "*" || range === "latest" || range.startsWith(">")) {
        findings.push({ kind: "pinned_floating", detail: `${pkg} uses floating range "${range}"` });
      }
    }
  }
  return findings;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function summarise(repoName: string, findings: DependencyFinding[]): string {
  const counts = { outdated: 0, vulnerable: 0, pinned_floating: 0 };
  for (const f of findings) counts[f.kind]++;
  const head =
    `Dependency-hygiene scan of ${repoName} found ${findings.length} issue(s): ` +
    `${counts.outdated} outdated, ${counts.vulnerable} vulnerable, ${counts.pinned_floating} floating ranges.`;
  const detail = findings
    .slice(0, 15)
    .map((f) => `  - ${f.kind}: ${f.detail}`)
    .join("\n");
  return `${head}\n${detail}`;
}

/**
 * Scan one repo for dependency-hygiene findings: floating ranges in
 * package.json, plus outdated/vulnerable findings from the configured audit
 * command's output (if any).
 */
export function scanDependencies(
  deps: IdleLoopDeps,
  repo: RepoConfig,
  root: string,
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    findings.push(...scanPackageJson(safeRead(pkgPath)));
  }

  const auditCommand = deps.config.loops.idle_dependencies.audit_command;
  if (auditCommand) {
    const result = deps.runner.run(auditCommand, root);
    findings.push(...parseAudit(result.stdout));
    findings.push(...parseOutdated(result.stdout));
  }
  return findings;
}

/**
 * Idle dependency-hygiene loop. Per in-scope repo, parses package.json and the
 * configured audit/outdated command output, then creates a DRAFT ticket when
 * issues are found. Observation only — never edits code or runs installs.
 */
export function runIdleDependencyLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const { repos: allow, mode, min_delivered_tickets } = deps.config.loops.idle_dependencies;
  const minDelivered = resolveMinDeliveredTickets(deps.config.loops, min_delivered_tickets);
  const candidates = repoCandidates(deps, allow, { loop: LOOP, minDelivered });
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);
    const findings = scanDependencies(deps, repo, root);
    deps.events.record("dependency_scanned", { repoName: repo.name, findings: findings.length });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Dependency hygiene: ${repo.name}`,
        summarise(repo.name, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}
