import { relative } from "node:path";

import {
  applyScanFinding,
  finalizeScan,
  isTestFile,
  repoCandidates,
  safeRead,
  shouldSkipForReadyTickets,
  walkFiles,
  type IdleScanOutcome,
} from "./idleScans.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import { resolveMinDeliveredTickets, type RepoConfig } from "../config/schema.js";
import { dateStamp } from "../util/clock.js";
import {
  oracleFindingKey,
  summariseOracleFindings,
  type Oracle,
  type OracleFinding,
} from "./oracles/index.js";

const LOOP = "tech_debt";

/**
 * Skills the drafted ticket hands a delivery agent. Both confirmed under
 * `runner/skills/`: `refactor-module` (split god-files / hotspots) and
 * `minimalism` (remove duplication / dead weight). They match the audit's named
 * skills exactly.
 */
const SKILL_IDS = ["refactor-module", "minimalism"] as const;

/** Sliding-window size for the lexical-duplication detector (10 lines). */
const DUP_WINDOW = 10;
/** A duplicated window is only interesting if it carries real content. */
const DUP_MIN_NONBLANK_LINES = 4;

/**
 * One tech-debt hotspot found in a repo. Carries the file (the location), the
 * `kind` (which signal), a `severity` used for ranking, the file's `loc`, and a
 * human-readable `why`. Churn hotspots also carry `churn` (commit count) and the
 * `product` (churn × loc) that crossed the threshold.
 */
export interface TechDebtFinding {
  file: string;
  kind: "churn_size" | "god_file" | "duplication";
  /** Higher = more severe; drives top-of-list ranking and summary order. */
  severity: number;
  loc: number;
  churn?: number;
  product?: number;
  why: string;
}

// Severity ranks (higher = worse). Churn×size hotspots are the strongest signal
// (frequently-changed *and* large = the costliest files to keep touching), then
// god-files (large but maybe stable), then lexical duplication (copy-paste).
const SEVERITY = {
  churn_size: 3,
  god_file: 2,
  duplication: 1,
} as const satisfies Record<TechDebtFinding["kind"], number>;

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|php)$/i;

/** Source files worth scanning: code files, excluding test/spec files (noisy). */
export function isTechDebtScanFile(name: string): boolean {
  return SOURCE_FILE_RE.test(name) && !isTestFile(name);
}

/** Count non-empty lines (LOC). Blank lines are excluded so size reflects code. */
export function countLoc(source: string): number {
  let loc = 0;
  for (const line of source.split("\n")) {
    if (line.trim().length > 0) loc++;
  }
  return loc;
}

/**
 * Parse a commit count from a `git log --pretty=%H -- <file>` result: one commit
 * hash per line, so the count is the number of non-blank lines. A bare integer is
 * also accepted (a legacy `| wc -l` shape or a test stub). Returns 0 on empty
 * output so a churn lookup never throws.
 */
export function parseCommitCount(stdout: string): number {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Run `git log` to count the commits that have touched `file`. Uses the injected
 * runner's `runArgs` (no shell, explicit argv) — NOT a `run("git log … ${file}")`
 * string — because `file` is an on-disk filename and therefore attacker-
 * influenceable: a file named `$(touch PWNED).ts` interpolated into a shell
 * string would execute. The `| wc -l` pipe is dropped; we count the returned
 * commit-hash lines in JS instead.
 */
function commitCount(deps: IdleLoopDeps, root: string, file: string): number {
  const result = deps.runner.runArgs("git", ["log", "--pretty=%H", "--", file], root);
  return parseCommitCount(result.stdout);
}

/**
 * Detect lexical duplication: hash every 10-line sliding window across all
 * scanned files (trimmed, blank-only windows ignored) and report each cluster of
 * identical windows that appears in ≥2 distinct places. Returns one finding per
 * file that participates in any cluster.
 */
export function detectDuplication(
  fileSources: ReadonlyArray<{ file: string; source: string }>,
): TechDebtFinding[] {
  // window hash → set of files it appears in (with a count of occurrences).
  const windows = new Map<string, { files: Set<string>; occurrences: number }>();

  for (const { file, source } of fileSources) {
    const lines = source.split("\n");
    for (let i = 0; i + DUP_WINDOW <= lines.length; i++) {
      const window = lines.slice(i, i + DUP_WINDOW).map((l) => l.trim());
      const nonBlank = window.filter((l) => l.length > 0).length;
      if (nonBlank < DUP_MIN_NONBLANK_LINES) continue;
      const hash = window.join("\n");
      const entry = windows.get(hash) ?? { files: new Set<string>(), occurrences: 0 };
      entry.files.add(file);
      entry.occurrences += 1;
      windows.set(hash, entry);
    }
  }

  // A cluster is a window appearing in ≥2 places. Collect, per file, how many
  // distinct duplicated windows it participates in.
  const clustersByFile = new Map<string, number>();
  for (const entry of windows.values()) {
    const isCluster = entry.files.size >= 2 || entry.occurrences >= 2;
    if (!isCluster) continue;
    // Only count cross-place duplication (≥2 files, or ≥2 occurrences in one file).
    if (entry.files.size < 2 && entry.occurrences < 2) continue;
    for (const file of entry.files) {
      clustersByFile.set(file, (clustersByFile.get(file) ?? 0) + 1);
    }
  }

  const findings: TechDebtFinding[] = [];
  for (const [file, clusters] of clustersByFile) {
    findings.push({
      file,
      kind: "duplication",
      severity: SEVERITY.duplication,
      loc: 0,
      why: `Lexical duplication: ${clusters} cluster(s) of ${DUP_WINDOW}+ identical lines shared with other locations.`,
    });
  }
  return findings;
}

/**
 * Scan one repo for tech-debt hotspots. Deterministic: god-files (LOC over
 * `godFileLines`), churn×size hotspots (commit count × LOC over
 * `churnSizeProduct`, the commit count coming from the injected command runner),
 * and lexical duplication (10-line sliding-window clusters across files).
 * Findings are advisory, not proof — verify before acting.
 */
export function scanTechDebt(
  deps: IdleLoopDeps,
  root: string,
  files: readonly string[],
  godFileLines: number,
  churnSizeProduct: number,
): TechDebtFinding[] {
  const findings: TechDebtFinding[] = [];
  const fileSources: Array<{ file: string; source: string }> = [];

  for (const path of files) {
    const source = safeRead(path);
    const rel = relative(root, path);
    fileSources.push({ file: rel, source });
    const loc = countLoc(source);

    // Churn × size: a file that is both large and frequently changed is the
    // costliest to keep touching. Highest severity.
    const churn = commitCount(deps, root, rel);
    const product = churn * loc;
    if (product > churnSizeProduct) {
      findings.push({
        file: rel,
        kind: "churn_size",
        severity: SEVERITY.churn_size,
        loc,
        churn,
        product,
        why: `Churn×size hotspot: ${churn} commit(s) × ${loc} LOC = ${product} (> ${churnSizeProduct}). Frequently-changed large file — a refactor target.`,
      });
      continue; // already flagged as the strongest signal; don't double-count as a god-file.
    }

    // God-file: a large source file regardless of churn.
    if (loc > godFileLines) {
      findings.push({
        file: rel,
        kind: "god_file",
        severity: SEVERITY.god_file,
        loc,
        why: `God-file: ${loc} LOC (> ${godFileLines}). Oversized module — split into focused units.`,
      });
    }
  }

  findings.push(...detectDuplication(fileSources));
  return rank(findings);
}

/** Rank by severity (churn×size > god-file > duplication), then product/LOC, then file. */
function rank(findings: TechDebtFinding[]): TechDebtFinding[] {
  return [...findings].sort(
    (a, b) =>
      b.severity - a.severity ||
      (b.product ?? 0) - (a.product ?? 0) ||
      b.loc - a.loc ||
      a.file.localeCompare(b.file),
  );
}

function summarise(repoName: string, date: string, findings: readonly TechDebtFinding[]): string {
  const counts = { churn_size: 0, god_file: 0, duplication: 0 };
  for (const f of findings) counts[f.kind]++;
  const head =
    `Tech-debt scan of ${repoName} (${date}) found ${findings.length} hotspot(s): ` +
    `${counts.churn_size} churn×size, ${counts.god_file} god-file(s), ` +
    `${counts.duplication} duplication cluster(s). Heuristic findings — verify each before acting.`;
  const detail = findings
    .slice(0, 15)
    .map((f) => {
      const size = f.churn !== undefined ? `LOC ${f.loc} · churn ${f.churn}` : `LOC ${f.loc}`;
      return `  - ${f.kind} @ ${f.file} (${size}) — ${f.why}`;
    })
    .join("\n");
  const acceptance =
    `Skills: ${SKILL_IDS.join(" + ")}. Acceptance criteria (behaviour-preserving oracle): ` +
    `the repo's tests are green BEFORE and AFTER, with no public API change and no behaviour change.`;
  // NOTE(orchestration follow-up): a future upgrade fans out one delivery agent
  // per hotspot, each handed the `refactor-module` + `minimalism` skills, each
  // required to keep the repo's tests green or have its change discarded
  // (behaviour-preserving refactor). For now this loop is the deterministic
  // scan + draft only: it observes and drafts, never edits code.
  return `${head}\n\nTop hotspots:\n${detail}\n\n${acceptance}`;
}

const ORACLE_ACCEPTANCE =
  `Skills: ${SKILL_IDS.join(" + ")}. Acceptance criteria (behaviour-preserving oracle): ` +
  `the repo's tests are green BEFORE and AFTER, with no public API change and no behaviour change. ` +
  `(Findings are eslint / dead-code tool output — resolving them clears the tool.)`;

/**
 * Consult the tech-debt oracles (eslint, dead-code) for one repo and merge their
 * precise findings. Returns the merged findings when AT LEAST ONE oracle was
 * available (so the loop drafts from tool output), or `null` when none were —
 * meaning the loop must fall back to its heuristic scan. Logs the path taken.
 */
function tryTechDebtOracles(
  deps: IdleLoopDeps,
  oracles: { eslint?: Oracle; deadCode?: Oracle },
  repo: RepoConfig,
  root: string,
): { findings: OracleFinding[]; toolIds: string[] } | null {
  const merged: OracleFinding[] = [];
  const toolIds: string[] = [];
  let anyAvailable = false;

  for (const oracle of [oracles.eslint, oracles.deadCode]) {
    if (!oracle) continue;
    const result = oracle.consult(root);
    if (!result.available) {
      deps.events.record("tech_debt_oracle_unavailable", {
        repoName: repo.name,
        oracle: oracle.id,
        reason: result.reason,
      });
      continue;
    }
    anyAvailable = true;
    toolIds.push(oracle.id);
    merged.push(...result.findings);
  }

  if (!anyAvailable) return null;
  deps.events.record("tech_debt_scanned", {
    repoName: repo.name,
    findings: merged.length,
    path: "oracle",
    oracles: toolIds,
  });
  return { findings: merged, toolIds };
}

/**
 * Idle tech-debt loop. PREFERS its tool oracles (eslint quality/complexity +
 * knip/ts-prune dead-code) when wired and installed, drafting from their precise
 * findings; otherwise falls back to walking each in-scope repo's non-test source
 * files and flagging the heuristic refactor hotspots — god-files, churn×size
 * hotspots (commit count via the injected command runner × LOC), and lexical
 * duplication clusters. Either way it drafts ONE observation-only ticket per repo
 * handing a delivery agent the `refactor-module` + `minimalism` skills with a
 * behaviour-preserving acceptance oracle, and logs the path taken (`oracle` vs
 * `heuristic`). Observation only — never edits code.
 */
export function runIdleTechDebtLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const {
    repos: allow,
    mode,
    min_delivered_tickets,
    god_file_lines,
    churn_size_product_threshold,
  } = deps.config.loops.idle_tech_debt;
  const minDelivered = resolveMinDeliveredTickets(deps.config.loops, min_delivered_tickets);
  const candidates = repoCandidates(deps, allow, { loop: LOOP, minDelivered });
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const date = dateStamp(deps.clock);
  const oracleSet: { eslint?: Oracle; deadCode?: Oracle } = {
    ...(deps.oracles?.eslint ? { eslint: deps.oracles.eslint } : {}),
    ...(deps.oracles?.deadCode ? { deadCode: deps.oracles.deadCode } : {}),
  };
  const hasOracle = Boolean(oracleSet.eslint || oracleSet.deadCode);
  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);

    // Oracle-first: when at least one tech-debt oracle is wired AND available,
    // draft from its precise findings instead of the grep heuristic.
    if (hasOracle) {
      const oracleResult = tryTechDebtOracles(deps, oracleSet, repo, root);
      if (oracleResult !== null) {
        if (oracleResult.findings.length === 0) {
          results.push(applyHandled());
          continue;
        }
        const label = oracleResult.toolIds.join("+");
        results.push(
          applyScanFinding(
            deps,
            LOOP,
            mode,
            repo,
            `Tech-debt hotspots: ${repo.name}`,
            `${summariseOracleFindings(repo.name, label, oracleResult.findings, ORACLE_ACCEPTANCE)}\n\n(${date})`,
            oracleFindingKey(label, oracleResult.findings),
          ),
        );
        continue;
      }
    }

    const files = walkFiles(root, isTechDebtScanFile);
    const findings = scanTechDebt(deps, root, files, god_file_lines, churn_size_product_threshold);
    deps.events.record("tech_debt_scanned", {
      repoName: repo.name,
      findings: findings.length,
      path: "heuristic",
    });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Tech-debt hotspots: ${repo.name}`,
        summarise(repo.name, date, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}

/** A no-op "handled, nothing to draft" result (oracle ran clean). */
function applyHandled(): ReturnType<typeof applyScanFinding> {
  return { kind: "deduped" };
}
