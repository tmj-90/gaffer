import type { Repository, ScopeNode, TicketRepoAccess } from "../domain/types.js";
import { RepoRepository } from "../repositories/repoRepository.js";
import { ScopeNodeRepository } from "../repositories/scopeNodeRepository.js";
import {
  ScopeRepoRepository,
  type ScopeRepoWithRepo,
} from "../repositories/scopeRepoRepository.js";

/**
 * The access a suggestion proposes. Mirrors {@link TicketRepoAccess} but never
 * suggests `none` — a "don't touch this" outcome is simply the absence of a
 * suggestion. So the suggested access is always one of write/read/test.
 */
export type SuggestedAccess = Extract<TicketRepoAccess, "write" | "read" | "test">;

/** One advisory repo suggestion for a ticket. */
export interface RepoSuggestion {
  repoId: string;
  repoName: string;
  suggestedAccess: SuggestedAccess;
  /** 0..1 confidence. */
  confidence: number;
  /** Human-readable reasons, de-duplicated and merged when repos collapse. */
  reasons: string[];
  /** True when confidence < {@link LOW_CONFIDENCE_THRESHOLD}; surface as a hint. */
  lowConfidence: boolean;
  /**
   * True only for the single-unmapped-repo mono-fallback suggestion. This is the
   * ONE case the caller may auto-confirm to a write boundary (via
   * applyMonoFallback); every other write suggestion stays advisory.
   */
  monoFallback: boolean;
}

/**
 * Suggest by an existing ticket (its confirmed scope links + its title/description)
 * OR by a pre-create draft (title/description/scopeNodeIds). Exactly one form is
 * used; the facade resolves a ticket form into the by-fields form before calling
 * the engine.
 */
export interface SuggestByTicket {
  ticketId: string;
}
export interface SuggestByFields {
  title?: string | undefined;
  description?: string | undefined;
  scopeNodeIds?: string[] | undefined;
}
export type SuggestInput = SuggestByTicket | SuggestByFields;

/** Suggestions below this confidence are flagged `lowConfidence`. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Base confidence for a strong write signal (owns / write_target / default write). */
const WRITE_CONFIDENCE = 0.9;
/** Base confidence for a read/test context signal. */
const READ_CONFIDENCE = 0.4;
/** Confidence added per distinct keyword token that overlaps a repo. */
const KEYWORD_BOOST = 0.15;
/** Confidence cap below the certain (1.0) reserved for mono-fallback. */
const MAX_HEURISTIC_CONFIDENCE = 0.98;

/** scope_repos relations that imply the ticket should WRITE to the repo. */
const WRITE_RELATIONS: ReadonlySet<string> = new Set(["owns", "write_target"]);
/** Minimum token length considered for keyword overlap (drops "to", "a", "of"…). */
const MIN_TOKEN_LENGTH = 3;
/** Common words that carry no repo-matching signal. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "add",
  "fix",
  "update",
  "support",
  "use",
  "using",
  "make",
  "should",
  "must",
  "when",
  "ticket",
  "repo",
  "repos",
  "code",
  "work",
  "change",
  "feature",
  "new",
]);

/**
 * A mutable accumulator while we collapse multiple signals onto one repo. We keep
 * the strongest access (write > test > read) and the max confidence, and union
 * the reasons.
 */
interface Accumulator {
  repoId: string;
  repoName: string;
  access: SuggestedAccess;
  confidence: number;
  reasons: Set<string>;
  monoFallback: boolean;
}

/** Rank of a suggested access; higher wins when a repo collects several signals. */
function accessRank(access: SuggestedAccess): number {
  switch (access) {
    case "write":
      return 2;
    case "test":
      return 1;
    case "read":
      return 0;
  }
}

/**
 * FG-005 scope-to-repo suggestion engine (Dispatch-native).
 *
 * Heuristic, advisory-by-design: it proposes repos with an access, a confidence
 * and human reasons, but NEVER confirms a write boundary itself. The single
 * exception is the mono-fallback case (one selected repo, unmapped) which is
 * returned with `monoFallback:true` and confidence 1.0 so the caller can promote
 * it deterministically via applyMonoFallback.
 *
 * Signals, in order:
 *  1. Scope→repo graph mappings of the selected scope nodes (the strong signal).
 *  2. Keyword overlap between the ticket title/description and a repo's
 *     name / tags / stack (a confidence boost + reason).
 *
 * NOTE (Memory, deferred — LG-001): a lore signal would slot in here as a
 * THIRD pass — Memory records matching the ticket's scope/repo/lore-tags would
 * ADD reasons (and a modest confidence nudge) but, like keyword overlap, must
 * never auto-confirm a write target. Wire it where {@link applyKeywordBoost} runs.
 */
export class SuggestionService {
  private readonly repos: RepoRepository;
  private readonly scopeNodes: ScopeNodeRepository;
  private readonly scopeRepos: ScopeRepoRepository;

  constructor(
    private readonly deps: {
      repos: RepoRepository;
      scopeNodes: ScopeNodeRepository;
      scopeRepos: ScopeRepoRepository;
    },
  ) {
    this.repos = deps.repos;
    this.scopeNodes = deps.scopeNodes;
    this.scopeRepos = deps.scopeRepos;
  }

  /**
   * Suggest repos for a draft/ticket from explicit fields. The facade is
   * responsible for resolving a {@link SuggestByTicket} into title/description +
   * the ticket's confirmed/primary/secondary/implicit scope node ids.
   *
   * @param selectedRepoIds Repos the PO has directly selected for the ticket so
   *   far (used to detect the single-unmapped-repo mono-fallback case). Optional.
   */
  suggest(input: SuggestByFields, selectedRepoIds: readonly string[] = []): RepoSuggestion[] {
    const scopeNodeIds = input.scopeNodeIds ?? [];

    // Mono-fallback: the ONLY repo selected is unmapped (no scope-graph mapping)
    // and no scope nodes are in play → return a single certain write suggestion.
    const mono = this.monoFallbackSuggestion(selectedRepoIds, scopeNodeIds);
    if (mono) return [mono];

    const tokens = tokenize(`${input.title ?? ""} ${input.description ?? ""}`);
    const acc = new Map<string, Accumulator>();

    // Pass 1: scope→repo graph mappings of the selected scope nodes.
    for (const nodeId of scopeNodeIds) {
      const node = this.scopeNodes.findById(nodeId);
      if (!node) continue; // unknown node id: skip rather than throw (advisory).
      const links = this.scopeRepos.reposForScope(nodeId);
      for (const link of links) {
        this.applyScopeRepoSignal(acc, node, link);
      }
    }

    // Pass 2: keyword overlap boosts repos already surfaced AND can surface a
    // brand-new low-confidence read suggestion for an otherwise-unmatched repo
    // whose name/tags/stack the ticket mentions.
    this.applyKeywordBoost(acc, tokens, scopeNodeIds.length > 0);

    return this.finalize(acc);
  }

  /**
   * The mono-fallback suggestion when the ONLY selected repo is unmapped and no
   * scope nodes are involved. Confidence 1.0, write, `monoFallback:true`. Returns
   * null when the condition does not hold (zero/multiple repos, a mapped repo, or
   * any scope node selected).
   */
  private monoFallbackSuggestion(
    selectedRepoIds: readonly string[],
    scopeNodeIds: readonly string[],
  ): RepoSuggestion | null {
    if (scopeNodeIds.length > 0) return null;
    if (selectedRepoIds.length !== 1) return null;
    const repoRef = selectedRepoIds[0]!;
    const repo = this.repos.findById(repoRef) ?? this.repos.findByName(repoRef);
    if (!repo) return null;
    if (this.scopeRepos.scopesForRepo(repo.id).length > 0) return null; // mapped.
    return {
      repoId: repo.id,
      repoName: repo.name,
      suggestedAccess: "write",
      confidence: 1.0,
      reasons: ["single unmapped repo — mono fallback"],
      lowConfidence: false,
      monoFallback: true,
    };
  }

  /** Fold one scope→repo association into the accumulator for its repo. */
  private applyScopeRepoSignal(
    acc: Map<string, Accumulator>,
    node: ScopeNode,
    link: ScopeRepoWithRepo,
  ): void {
    const isWrite = WRITE_RELATIONS.has(link.relation) || link.default_access === "write";
    const access: SuggestedAccess = isWrite
      ? "write"
      : link.default_access === "test" || link.relation === "test_target"
        ? "test"
        : "read";

    const baseConfidence = isWrite ? WRITE_CONFIDENCE : READ_CONFIDENCE;
    // A scope_repos row may carry its own confidence; prefer the stronger signal.
    const confidence = Math.max(baseConfidence, link.confidence ?? 0);

    const reason = isWrite
      ? `scope '${node.name}' owns/targets this repo`
      : `read context for scope '${node.name}'`;

    this.merge(acc, {
      repoId: link.id,
      repoName: link.name,
      access,
      confidence,
      reason,
    });
  }

  /**
   * Keyword pass: for every repo the ticket text mentions (by name, a tag or its
   * stack), add a reason and a confidence boost. If the repo is already in the
   * accumulator we boost it; otherwise, when scope nodes WERE selected we only
   * boost existing repos (keyword alone shouldn't widen a scoped suggestion), and
   * when NO scope nodes were selected we surface a fresh low-confidence read
   * suggestion so a bare title still yields candidates.
   */
  private applyKeywordBoost(
    acc: Map<string, Accumulator>,
    tokens: Set<string>,
    hadScopeNodes: boolean,
  ): void {
    if (tokens.size === 0) return;
    for (const repo of this.repos.list()) {
      const matched = matchingTokens(repo, tokens);
      if (matched.length === 0) continue;
      const boost = Math.min(matched.length, 3) * KEYWORD_BOOST;
      const existing = acc.get(repo.id);
      if (existing) {
        existing.confidence = Math.min(MAX_HEURISTIC_CONFIDENCE, existing.confidence + boost);
        for (const tok of matched) {
          existing.reasons.add(`ticket mentions '${tok}' matching repo`);
        }
        continue;
      }
      if (hadScopeNodes) continue; // don't widen a scoped suggestion on keyword alone.
      this.merge(acc, {
        repoId: repo.id,
        repoName: repo.name,
        access: "read",
        confidence: Math.min(MAX_HEURISTIC_CONFIDENCE, READ_CONFIDENCE + boost),
        reason: `ticket mentions '${matched[0]}' matching repo`,
      });
      for (const tok of matched.slice(1)) {
        acc.get(repo.id)!.reasons.add(`ticket mentions '${tok}' matching repo`);
      }
    }
  }

  /**
   * Merge a single signal into the per-repo accumulator: keep the strongest
   * access, the highest confidence, and union the reasons (de-dupe by repo).
   */
  private merge(
    acc: Map<string, Accumulator>,
    signal: {
      repoId: string;
      repoName: string;
      access: SuggestedAccess;
      confidence: number;
      reason: string;
    },
  ): void {
    const existing = acc.get(signal.repoId);
    if (!existing) {
      acc.set(signal.repoId, {
        repoId: signal.repoId,
        repoName: signal.repoName,
        access: signal.access,
        confidence: signal.confidence,
        reasons: new Set([signal.reason]),
        monoFallback: false,
      });
      return;
    }
    if (accessRank(signal.access) > accessRank(existing.access)) {
      existing.access = signal.access;
    }
    existing.confidence = Math.max(existing.confidence, signal.confidence);
    existing.reasons.add(signal.reason);
  }

  /** Turn the accumulator into sorted, capped, low-confidence-flagged output. */
  private finalize(acc: Map<string, Accumulator>): RepoSuggestion[] {
    const out: RepoSuggestion[] = [];
    for (const a of acc.values()) {
      const confidence = clamp01(Math.min(a.confidence, MAX_HEURISTIC_CONFIDENCE));
      out.push({
        repoId: a.repoId,
        repoName: a.repoName,
        suggestedAccess: a.access,
        confidence,
        reasons: [...a.reasons],
        lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
        monoFallback: false,
      });
    }
    // Strongest, most confident suggestions first; stable by name as a tiebreak.
    out.sort(
      (x, y) =>
        accessRank(y.suggestedAccess) - accessRank(x.suggestedAccess) ||
        y.confidence - x.confidence ||
        x.repoName.localeCompare(y.repoName),
    );
    return out;
  }
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Tokenize free text into a set of lowercase keyword tokens: split on
 * non-alphanumerics, drop short tokens and stopwords.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Tokens from the ticket text that overlap a repo's identity: its name (split the
 * same way), its parsed tags (stack field is treated as comma/space-delimited
 * tags), and its stack tokens. Returns the matched ticket tokens (de-duped).
 *
 * `stack` doubles as the repo's tags here: Dispatch's repositories table has no
 * dedicated tags column, so a comma/space-delimited stack string ("ts, api,
 * commerce") is the closest tag surface. The FG-005 heuristic's "repo name/tags/
 * stack" overlap reads all three from here.
 */
function matchingTokens(repo: Repository, ticketTokens: Set<string>): string[] {
  const repoTokens = new Set<string>();
  for (const t of tokenize(repo.name)) repoTokens.add(t);
  if (repo.stack) for (const t of tokenize(repo.stack)) repoTokens.add(t);
  const matched: string[] = [];
  for (const t of ticketTokens) {
    if (repoTokens.has(t)) matched.push(t);
  }
  return matched;
}
