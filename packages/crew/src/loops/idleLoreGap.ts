/**
 * Idle lore-gap loop.
 *
 * Scans in-scope repos for repeated conventions/patterns (e.g. a directory
 * structure or import that recurs across files), checks whether Memory
 * already has a record covering them (`searchLore`), and for each uncovered
 * convention emits a Memory *suggestion* — never an approval. Optionally it
 * also drafts a Dispatch ticket to ratify the suggestion.
 *
 * This loop is ASYNC because it queries the real Memory MCP client. It NEVER
 * edits code: its only outputs are draft Memory suggestions and (optionally)
 * draft Dispatch tickets. It is wired in only at the async entry points, behind
 * the `loops.idle_lore_gap.enabled` config flag.
 */
import { relative } from "node:path";

import { dateStamp } from "../util/clock.js";
import { findingKey, repoCandidates, safeRead, walkFiles } from "./idleScans.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import type { AsyncMemoryClient } from "../memory/mcpClient.js";
import type { LoreSuggestionInput } from "../memory/client.js";
import type { RepoConfig } from "../config/schema.js";

const LOOP = "lore_gap";

/** A convention observed to recur across a repo's source. */
export interface ConventionCandidate {
  /** Stable key used for de-dup + Memory lookup (e.g. "import:zod"). */
  key: string;
  /** Searchable tag for Memory lookup. */
  tag: string;
  /** Human-facing title for the lore suggestion. */
  title: string;
  /** Number of files the pattern was observed in. */
  occurrences: number;
  /** A few example files for evidence. */
  examples: string[];
}

export type IdleLoreGapOutcome =
  | { status: "skipped_tickets_ready" }
  | { status: "no_repos" }
  | { status: "no_findings" }
  | { status: "suggested"; suggestions: LoreGapSuggestion[] };

export interface LoreGapSuggestion {
  repoName: string;
  key: string;
  suggestionId: string;
  ratifyTicketId?: string;
}

const SOURCE_RE = /\.[cm]?[jt]sx?$/i;
const IMPORT_RE = /import\b[^;]*?from\s*['"]([^'"./][^'"]*)['"]/g;

/** Top-level package name from an import specifier (handles scoped packages). */
function packageRoot(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split("/")[0]!;
}

/**
 * Detect repeated conventions in a repo's source. The MVP heuristic: a
 * third-party package imported across many files is a de-facto convention worth
 * ratifying in lore. Pure + dependency-free so it is unit-testable.
 */
export function detectConventions(
  files: ReadonlyArray<{ path: string; source: string }>,
  minimumOccurrences: number,
): ConventionCandidate[] {
  const byPackage = new Map<string, Set<string>>();
  for (const { path, source } of files) {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(source)) !== null) {
      const pkg = packageRoot(m[1]!);
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      const files = byPackage.get(pkg) ?? new Set<string>();
      files.add(path);
      byPackage.set(pkg, files);
    }
  }

  const candidates: ConventionCandidate[] = [];
  for (const [pkg, fileSet] of byPackage) {
    if (fileSet.size < minimumOccurrences) continue;
    candidates.push({
      key: `import:${pkg}`,
      tag: `convention:${pkg}`,
      title: `Standardise on '${pkg}'`,
      occurrences: fileSet.size,
      examples: [...fileSet].slice(0, 5),
    });
  }
  candidates.sort((a, b) => b.occurrences - a.occurrences);
  return candidates;
}

/** True when Memory already has a record covering this convention. */
async function loreCovers(
  client: AsyncMemoryClient,
  candidate: ConventionCandidate,
): Promise<boolean> {
  const records = await client.searchLore({
    tags: [candidate.tag],
    text: candidate.title,
    limit: 5,
  });
  return records.length > 0;
}

export interface IdleLoreGapDeps extends IdleLoopDeps {
  memory: AsyncMemoryClient;
}

/**
 * Run the idle lore-gap loop. For each in-scope repo: detect repeated
 * conventions, skip those Memory already covers, and SUGGEST the rest
 * (optionally drafting a ratify ticket). Never edits code; never approves lore.
 */
export async function runIdleLoreGapLoop(deps: IdleLoreGapDeps): Promise<IdleLoreGapOutcome> {
  deps.events.record("loop_started", { loop: LOOP });

  if (deps.dispatch.listReady().length > 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "skipped_tickets_ready" });
    return { status: "skipped_tickets_ready" };
  }

  const cfg = deps.config.loops.idle_lore_gap;
  const candidates = repoCandidates(deps, cfg.repos);
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const suggestions: LoreGapSuggestion[] = [];
  for (const repo of candidates) {
    suggestions.push(
      ...(await scanRepo(deps, repo, cfg.minimum_occurrences, cfg.draft_ratify_ticket)),
    );
  }

  if (suggestions.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_findings" });
    return { status: "no_findings" };
  }
  deps.events.record("loop_finished", {
    loop: LOOP,
    result: "suggested",
    count: suggestions.length,
  });
  return { status: "suggested", suggestions };
}

async function scanRepo(
  deps: IdleLoreGapDeps,
  repo: RepoConfig,
  minimumOccurrences: number,
  // NOTE: currently unused in the scan body — kept in the signature (and passed
  // by the caller) so the draft-ratify wiring is explicit and easy to restore.
  _draftRatify: boolean,
): Promise<LoreGapSuggestion[]> {
  const root = deps.repoRegistry.absolutePath(repo);
  const paths = walkFiles(root, (name) => SOURCE_RE.test(name));
  const files = paths.map((p) => ({ path: relative(root, p), source: safeRead(p) }));
  const conventions = detectConventions(files, minimumOccurrences);
  deps.events.record("lore_gap_scanned", { repoName: repo.name, conventions: conventions.length });

  const out: LoreGapSuggestion[] = [];
  for (const candidate of conventions) {
    if (await loreCovers(deps.memory, candidate)) {
      deps.events.record("lore_gap_covered", { repoName: repo.name, key: candidate.key });
      continue;
    }
    const result = await suggestConvention(deps, repo, candidate);
    out.push(result);
  }
  return out;
}

async function suggestConvention(
  deps: IdleLoreGapDeps,
  repo: RepoConfig,
  candidate: ConventionCandidate,
): Promise<LoreGapSuggestion> {
  const summary =
    `Observed convention in ${repo.name}: ${candidate.title}. ` +
    `Imported in ${candidate.occurrences} file(s), e.g. ${candidate.examples.join(", ")}. ` +
    `This is a DRAFT lore suggestion — a human ratifies it; nothing was approved or changed.`;

  const input: LoreSuggestionInput = {
    title: `${candidate.title} (${repo.name})`,
    summary,
    tags: [candidate.tag, repo.name],
  };
  const suggestion = await deps.memory.suggestLore(input);
  deps.events.record("lore_suggested", {
    repoName: repo.name,
    key: candidate.key,
    suggestionId: suggestion.suggestionId,
  });

  const result: LoreGapSuggestion = {
    repoName: repo.name,
    key: candidate.key,
    suggestionId: suggestion.suggestionId,
  };

  const draftRatify = deps.config.loops.idle_lore_gap.draft_ratify_ticket;
  if (draftRatify) {
    // Dedup the ratify ticket per convention (the candidate.key is the stable
    // finding signature) so a re-run doesn't draft a fresh ticket each tick —
    // worse here than other loops because searchLore excludes drafts, so the
    // suggestion keeps re-surfacing.
    const key = findingKey(LOOP, repo.name, candidate.key);
    const existing = deps.dispatch.findOpenTicketByFindingKey(key);
    if (existing) {
      deps.events.record("idle_finding_deduped", {
        loop: LOOP,
        repoName: repo.name,
        findingKey: key,
        ticketId: existing.ticketId,
      });
      result.ratifyTicketId = existing.ticketId;
      return result;
    }
    const draft = deps.dispatch.createDraftTicket({
      title: `Ratify lore: ${candidate.title} (${dateStamp(deps.clock)})`,
      description:
        `Idle ${LOOP} scan suggested durable lore for ${repo.name}. This is an observation-only ` +
        `draft to RATIFY the suggestion — no code was changed and no lore was approved.\n\n${summary}`,
      repoName: repo.name,
      evidenceSummary: summary,
      findingKey: key,
      policyPack: deps.config.dispatch.default_policy_pack,
    });
    deps.events.record("idle_ticket_created", {
      loop: LOOP,
      ticketId: draft.ticketId,
      number: draft.number,
      repoName: repo.name,
    });
    result.ratifyTicketId = draft.ticketId;
  }

  return result;
}
