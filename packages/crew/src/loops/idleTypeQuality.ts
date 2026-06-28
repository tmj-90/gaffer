import { basename, relative } from "node:path";

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

const LOOP = "type_quality";

/** Skill the drafted ticket hands a delivery agent (confirmed in runner/skills). */
const SKILL_ID = "typescript-conventions";

/**
 * One type-debt signal found in source. Carries the file + line (the location),
 * the `kind` (which signal), a `severity` used for ranking, and a short
 * single-line `snippet` for context.
 *
 * The codebase is already type-clean for bare `any` / `@ts-ignore`, so the loop
 * ranks the *real* debt — `skipLibCheck:true`, suppression comments, `as` casts
 * and non-null `!` — above bare `any`, which is rarest here.
 */
export interface TypeQualityFinding {
  file: string;
  line: number;
  kind: "skip_lib_check" | "ts_suppression" | "cast" | "non_null" | "any";
  /** Higher = more severe; drives top-of-list ranking and the summary order. */
  severity: number;
  snippet: string;
}

// Severity ranks (higher = worse). skipLibCheck / @ts-* suppressions are the
// strongest signal (they switch off the checker), then `as` casts and non-null
// `!` (local soundness holes), then bare `any` (rarest here, but still debt).
const SEVERITY = {
  skip_lib_check: 4,
  ts_suppression: 3,
  cast: 2,
  non_null: 2,
  any: 1,
} as const satisfies Record<TypeQualityFinding["kind"], number>;

const TS_FILE_RE = /\.tsx?$/i;
const TSCONFIG_RE = /^tsconfig.*\.json$/i;

/**
 * Files worth scanning: non-test TypeScript sources (`.ts`/`.tsx`) for the
 * in-code signals, plus `tsconfig*.json` for the `skipLibCheck` setting. Test
 * files are skipped — fixtures and assertions are noisy for `as`/`!`.
 */
export function isTypeScanFile(name: string): boolean {
  if (TSCONFIG_RE.test(name)) return true;
  return TS_FILE_RE.test(name) && !isTestFile(name);
}

// ── Detectors (line-based heuristics, no AST) ───────────────────────────────
// Best-effort and intentionally conservative, matching the sibling scans'
// "grep the repo" approach. Findings are advisory, not proof.

/** `as Type` / `as const` / `as unknown as` — but NOT `import ... as x`. */
const CAST_RE = /\bas\s+(?:const\b|unknown\b|[A-Z_$][\w$]*(?:<|\[|\.|\b))/;
/** A non-null assertion `x!` / `foo()!` / `arr[i]!` — value-position `!`. */
const NON_NULL_RE = /[\w$)\]]!\s*(?:[.;,)\]}=]|$)/;
/** Any `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` suppression comment. */
const TS_SUPPRESSION_RE = /@ts-(?:ignore|nocheck|expect-error)\b/;
/** Bare `any` as a type annotation / generic arg — not inside an identifier. */
const ANY_RE = /(?<![\w$])any(?![\w$])/;
/** `skipLibCheck: true` in a tsconfig (whitespace-tolerant). */
const SKIP_LIB_CHECK_RE = /"skipLibCheck"\s*:\s*true/;
/** `!=`/`!==` and the logical-not prefix are not non-null assertions. */
const NOT_OPERATOR_RE = /!=|^\s*!|[\s(!&|]!/;

/**
 * Decide whether `any` on a line is a real type usage rather than an incidental
 * substring (e.g. a string, a word like "anyone"). Conservative: require it to
 * sit next to type punctuation (`:`, `<`, `>`, `,`, `|`, `&`, `[`, `(`, `=`).
 */
function looksLikeAnyType(line: string): boolean {
  if (!ANY_RE.test(line)) return false;
  return /[:<>,|&([=]\s*any\b|\bany\s*[>,|&)\]=]/.test(line);
}

/**
 * Scan one file's source for type-debt signals. `tsconfig*.json` files are
 * scanned only for `skipLibCheck:true`; `.ts`/`.tsx` sources are scanned for
 * suppression comments, `as` casts, non-null `!`, and bare `any`. Best-effort
 * line scanning — no TS parsing.
 */
export function scanTypeQuality(source: string, file: string): TypeQualityFinding[] {
  const findings: TypeQualityFinding[] = [];
  const lines = source.split("\n");
  const isTsconfig = TSCONFIG_RE.test(basename(file));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const push = (kind: TypeQualityFinding["kind"]): void => {
      findings.push({
        file,
        line: i + 1,
        kind,
        severity: SEVERITY[kind],
        snippet: line.trim().slice(0, 120),
      });
    };

    if (isTsconfig) {
      if (SKIP_LIB_CHECK_RE.test(line)) push("skip_lib_check");
      continue;
    }

    if (TS_SUPPRESSION_RE.test(line)) push("ts_suppression");
    if (CAST_RE.test(line)) push("cast");
    if (NON_NULL_RE.test(line) && !NOT_OPERATOR_RE.test(line)) push("non_null");
    if (looksLikeAnyType(line)) push("any");
  }
  return findings;
}

/**
 * Group findings by file and rank files by hotspot count (then severity), so
 * the drafted ticket leads with the files carrying the most type debt.
 */
function topFiles(
  findings: readonly TypeQualityFinding[],
): Array<{ file: string; count: number; weight: number }> {
  const byFile = new Map<string, { count: number; weight: number }>();
  for (const f of findings) {
    const entry = byFile.get(f.file) ?? { count: 0, weight: 0 };
    entry.count += 1;
    entry.weight += f.severity;
    byFile.set(f.file, entry);
  }
  return [...byFile.entries()]
    .map(([file, e]) => ({ file, count: e.count, weight: e.weight }))
    .sort((a, b) => b.count - a.count || b.weight - a.weight || a.file.localeCompare(b.file));
}

function summarise(repoName: string, date: string, findings: TypeQualityFinding[]): string {
  const counts = { skip_lib_check: 0, ts_suppression: 0, cast: 0, non_null: 0, any: 0 };
  for (const f of findings) counts[f.kind]++;
  const head =
    `Type-quality scan of ${repoName} (${date}) found ${findings.length} signal(s): ` +
    `${counts.skip_lib_check} skipLibCheck, ${counts.ts_suppression} @ts-* suppression(s), ` +
    `${counts.cast} \`as\` cast(s), ${counts.non_null} non-null \`!\`, ${counts.any} bare \`any\`. ` +
    `Heuristic findings — verify each before acting.`;
  const fileList = topFiles(findings)
    .slice(0, 15)
    .map((f) => `  - ${f.file} — ${f.count} hotspot(s)`)
    .join("\n");
  const acceptance =
    `Skill: ${SKILL_ID}. Acceptance criteria: \`pnpm typecheck\` and \`pnpm test\` stay green ` +
    `and no public API change.`;
  // NOTE(orchestration follow-up): a future upgrade fans out one delivery agent
  // per hotspot cluster (e.g. per top file), each handed the
  // `typescript-conventions` skill, each required to keep `pnpm typecheck` +
  // `pnpm test` green or have its change discarded. For now this loop is the
  // basic deterministic scan only: it observes and drafts, never edits code.
  return `${head}\n\nTop files by type-debt hotspot count:\n${fileList}\n\n${acceptance}`;
}

/**
 * Idle type-quality loop. Walks each in-scope repo's non-test TypeScript sources
 * and tsconfigs, flags type-debt signals (`skipLibCheck:true`, `@ts-*`
 * suppressions, `as` casts, non-null `!`, bare `any`), and creates a DRAFT
 * ticket per repo with a top-files-by-hotspot summary. Observation only — never
 * edits code; a delivery agent (not this scan) would later remediate.
 */
export function runIdleTypeQualityLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const { repos: allow, mode, min_delivered_tickets } = deps.config.loops.idle_type_quality;
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
    const files = walkFiles(root, isTypeScanFile);
    const findings: TypeQualityFinding[] = [];
    for (const path of files) {
      findings.push(...scanTypeQuality(safeRead(path), relative(root, path)));
    }
    deps.events.record("type_quality_scanned", { repoName: repo.name, findings: findings.length });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Type-quality findings: ${repo.name}`,
        summarise(repo.name, date, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}
