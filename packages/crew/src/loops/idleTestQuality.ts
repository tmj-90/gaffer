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

const LOOP = "test_quality";

export interface TestQualityFinding {
  file: string;
  line: number;
  kind: "skipped" | "focused" | "no_assertion";
  snippet: string;
}

const SKIP_RE = /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.todo\s*\(/;
const FOCUS_RE = /\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/;
const TEST_OPEN_RE = /\b(?:it|test)\s*\(\s*(['"`])/;
const ASSERTION_RE = /\b(?:expect|assert|should|t\.(?:is|ok|deepEqual|truthy|throws))\b/;

/**
 * Scan a test file's source for quality smells: skipped tests, focused tests
 * (`.only`/`fit`), and `it(...)` blocks with no assertion. Best-effort line
 * scanning — no TS parsing — matching the doc's "grep the repo" heuristic.
 */
export function scanTestQuality(source: string, file: string): TestQualityFinding[] {
  const findings: TestQualityFinding[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SKIP_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: "skipped", snippet: line.trim().slice(0, 120) });
    }
    if (FOCUS_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: "focused", snippet: line.trim().slice(0, 120) });
    }
    if (TEST_OPEN_RE.test(line)) {
      const block = collectBlock(lines, i);
      if (block.text.length > 0 && !ASSERTION_RE.test(block.text)) {
        findings.push({
          file,
          line: i + 1,
          kind: "no_assertion",
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return findings;
}

/** Collect the brace-balanced body starting at the test-open line. Bounded. */
function collectBlock(lines: string[], start: number): { text: string } {
  let depth = 0;
  let started = false;
  const parts: string[] = [];
  for (let i = start; i < lines.length && i < start + 200; i++) {
    const line = lines[i]!;
    parts.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }
  return { text: parts.join("\n") };
}

function summarise(repoName: string, findings: TestQualityFinding[]): string {
  const counts = { skipped: 0, focused: 0, no_assertion: 0 };
  for (const f of findings) counts[f.kind]++;
  const head =
    `Test-quality scan of ${repoName} found ${findings.length} smell(s): ` +
    `${counts.skipped} skipped, ${counts.focused} focused (.only), ${counts.no_assertion} without assertions.`;
  const detail = findings
    .slice(0, 10)
    .map((f) => `  - ${f.kind} @ ${f.file}:${f.line} — ${f.snippet}`)
    .join("\n");
  return `${head}\n${detail}`;
}

/**
 * Idle test-quality loop. Walks each in-scope repo's test files, flags skipped /
 * focused / assertion-less tests, and creates a DRAFT ticket per repo with
 * findings. Observation only — never edits code.
 */
export function runIdleTestQualityLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const { repos: allow, mode, min_delivered_tickets } = deps.config.loops.idle_test_quality;
  const minDelivered = resolveMinDeliveredTickets(deps.config.loops, min_delivered_tickets);
  const candidates = repoCandidates(deps, allow, { loop: LOOP, minDelivered });
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);
    const files = walkFiles(root, isTestFile);
    const findings: TestQualityFinding[] = [];
    for (const path of files) {
      findings.push(...scanTestQuality(safeRead(path), relative(root, path)));
    }
    deps.events.record("test_quality_scanned", { repoName: repo.name, findings: findings.length });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Test-quality findings: ${repo.name}`,
        summarise(repo.name, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}
