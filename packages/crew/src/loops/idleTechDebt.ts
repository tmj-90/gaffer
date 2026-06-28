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
import { resolveMinDeliveredTickets } from "../config/schema.js";
import { dateStamp } from "../util/clock.js";

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
 * Parse a commit count from a `git log --pretty=%H -- <file> | wc -l` result.
 * `wc -l` yields a bare number; if the pipe is absent (or a test stubs raw
 * hashes) we fall back to counting non-blank lines. Returns 0 on any failure so
 * a churn lookup never throws.
 */
export function parseCommitCount(stdout: string): number {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Run `git log` (via the injected command runner — never raw child_process) to
 * count the commits that have touched `file`. The runner is the SAME injectable
 * `deps.runner` the coverage loop uses, so tests drive it through
 * `FakeCommandRunner` instead of spawning git.
 */
function commitCount(deps: IdleLoopDeps, root: string, file: string): number {
  const result = deps.runner.run(`git log --pretty=%H -- ${file} | wc -l`, root);
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

/**
 * Idle tech-debt loop. Walks each in-scope repo's non-test source files and
 * flags refactor hotspots — god-files, churn×size hotspots (commit count via the
 * injected command runner × LOC), and lexical duplication clusters — then drafts
 * ONE observation-only ticket per repo (dedup key `tech_debt:${repo}`) handing a
 * delivery agent the `refactor-module` + `minimalism` skills with a
 * behaviour-preserving acceptance oracle. Observation only — never edits code.
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
  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);
    const files = walkFiles(root, isTechDebtScanFile);
    const findings = scanTechDebt(deps, root, files, god_file_lines, churn_size_product_threshold);
    deps.events.record("tech_debt_scanned", { repoName: repo.name, findings: findings.length });
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
