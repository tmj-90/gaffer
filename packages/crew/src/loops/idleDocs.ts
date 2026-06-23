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

const LOOP = "documentation";

export interface DocFinding {
  kind: "missing_readme" | "missing_setup" | "stale_command";
  detail: string;
}

const README_CANDIDATES = ["README.md", "README.MD", "readme.md", "Readme.md"];
const SETUP_HEADING_RE =
  /^#{1,3}\s+(install|installation|setup|getting started|quick ?start|usage)\b/im;

/** Extract fenced + inline-backtick command-ish snippets from README text. */
function readmeCommands(readme: string): string[] {
  const commands: string[] = [];
  const fence = /```(?:bash|sh|shell|console|zsh)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(readme)) !== null) {
    for (const line of m[1]!.split("\n")) {
      const trimmed = line.replace(/^\$\s*/, "").trim();
      if (trimmed) commands.push(trimmed);
    }
  }
  return commands;
}

/**
 * Heuristic documentation scan. Flags a missing README, a README with no
 * setup/usage section, and README commands referencing a package manager the
 * repo isn't configured for (a cheap "stale command" signal).
 */
export function scanDocs(repo: RepoConfig, root: string): DocFinding[] {
  const findings: DocFinding[] = [];
  const readmePath = README_CANDIDATES.map((n) => join(root, n)).find((p) => existsSync(p));

  if (!readmePath) {
    findings.push({ kind: "missing_readme", detail: "No README.md found at the repo root." });
    return findings;
  }

  const readme = safeRead(readmePath);
  if (!SETUP_HEADING_RE.test(readme)) {
    findings.push({
      kind: "missing_setup",
      detail: "README has no install / setup / usage section.",
    });
  }

  const pm = repo.package_manager;
  if (pm) {
    const others = ["npm", "pnpm", "yarn", "poetry", "pip", "cargo"].filter((x) => x !== pm);
    for (const cmd of readmeCommands(readme)) {
      const head = cmd.split(/\s+/)[0]!;
      if (others.includes(head)) {
        findings.push({
          kind: "stale_command",
          detail: `README uses '${head}' but repo package_manager is '${pm}': "${cmd.slice(0, 80)}"`,
        });
      }
    }
  }
  return findings;
}

function summarise(repoName: string, findings: DocFinding[]): string {
  const head = `Documentation scan of ${repoName} found ${findings.length} gap(s).`;
  const detail = findings
    .slice(0, 10)
    .map((f) => `  - ${f.kind}: ${f.detail}`)
    .join("\n");
  return `${head}\n${detail}`;
}

/**
 * Idle documentation-gap loop. Per in-scope repo, runs the heuristic doc scan
 * and creates a DRAFT ticket when gaps are found. Observation only.
 */
export function runIdleDocsLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const { repos: allow, mode, min_delivered_tickets } = deps.config.loops.idle_documentation;
  const minDelivered = resolveMinDeliveredTickets(deps.config.loops, min_delivered_tickets);
  const candidates = repoCandidates(deps, allow, { loop: LOOP, minDelivered });
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);
    const findings = scanDocs(repo, root);
    deps.events.record("documentation_scanned", { repoName: repo.name, findings: findings.length });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Documentation gaps: ${repo.name}`,
        summarise(repo.name, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}
