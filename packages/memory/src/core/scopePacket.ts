/**
 * Scope Packet — budgeted, prioritised file-card assembly for agent prompts.
 *
 * `cardsForScope` is the PRIMARY entry point agents and the runner use to
 * pull relevant file cards before starting a task. It implements a strict
 * selection priority so that deterministic signals (explicit file paths)
 * always outrank fuzzy heuristics (FTS), and it enforces hard token budgets
 * so the resulting packet is safe to push directly into a context window.
 *
 * FRAMING (non-negotiable — repeat this in every prompt that references cards):
 *   File cards are a RETRIEVAL AID. They help agents CHOOSE WHAT TO READ.
 *   A card is never authoritative source. Before editing any file, the agent
 *   MUST read the actual file (or a real excerpt). Absence of a card ≠ the
 *   file is unimportant — it means we have no card yet.
 *
 * SELECTION PRIORITY (higher tier always wins dedup):
 *   1. Exact path matches    — `paths` list, exact card lookup.
 *   2. Path-prefix matches   — `paths` list, directory-prefix card lookup.
 *   3. Important paths       — `importantPaths` list, exact + prefix.
 *   4. FTS                   — `searchFileCards(query)` over path/tldr/symbols.
 *   5. Digest + lore         — repo digest + memory-native `searchLore(query)`.
 *
 * BUDGET CONTRACT:
 *   - `maxCards`         (default 20) — hard card count cap.
 *   - `maxTokens`        — cumulative token budget (estimated: chars/4).
 *     Cards that would exceed this budget move to `omitted`.
 *   - `perCardMaxTokens` — per-card token cap. Exceeded cards have their
 *     `tldr` truncated to fit; they are still returned (truncated), not omitted.
 *
 * OMISSION TRANSPARENCY:
 *   The result always includes an `omitted` list (path + reason) and a
 *   `coverage` summary. Callers must surface what was dropped — absence
 *   of a card in the result does NOT mean the file is irrelevant.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import type { Database } from "better-sqlite3";

import {
  diagnoseRepoKeyMismatch,
  listCardsForPathPrefixes,
  listCardsForPaths,
  repoKey as computeRepoKey,
  searchFileCards,
} from "./fileCards.js";
import { getDigest } from "./repoUnderstanding.js";
import { searchLore } from "./lore.js";
import type { FileCard, LoreSummary, RepoDigest } from "../db/types.js";

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_MAX_CARDS = 20;
const DEFAULT_LORE_LIMIT = 5;
/** Rough chars-per-token estimate for budget calculations. */
const CHARS_PER_TOKEN = 4;

// ── Public types ──────────────────────────────────────────────────────

/** How a particular card was selected — which priority tier picked it. */
export type SelectionTier =
  | "exact-path"
  | "path-prefix"
  | "important-path"
  | "important-prefix"
  | "fts";

export interface SelectionEntry {
  readonly path: string;
  readonly tier: SelectionTier;
}

export interface OmittedEntry {
  readonly path: string;
  /** Why this card was not included: budget or no card exists. */
  readonly reason: "budget-maxCards" | "budget-maxTokens" | "no-card";
}

export interface CardCoverage {
  /** Number of distinct requested paths (paths + importantPaths). */
  readonly requested: number;
  /** Number of cards returned. */
  readonly served: number;
  /** Requested paths for which no active card exists in the DB. */
  readonly missing: readonly string[];
}

export interface ScopePacket {
  /**
   * Selected file cards, ordered by selection tier then by path within tier.
   * May have `tldr` truncated if `perCardMaxTokens` was set and the card
   * exceeded the per-card budget.
   */
  readonly cards: readonly FileCard[];
  /** The repo's current digest, or null if none has been written yet. */
  readonly digest: RepoDigest | null;
  /** Top lore records matching the query (from memory-native searchLore). */
  readonly lore: readonly LoreSummary[];
  /** Selection tier per card, in the same order as `cards`. */
  readonly selectionOrder: readonly SelectionEntry[];
  /**
   * Cards/paths that were excluded and why. Absence of a card here doesn't
   * mean the file is safe to ignore — it means either the budget was reached
   * or no card has been written for that file yet.
   */
  readonly omitted: readonly OmittedEntry[];
  /**
   * Set when the result was cut short by a budget limit.
   * Describes which limit was hit and how many items were dropped.
   */
  readonly truncationReason?: string;
  /**
   * Coverage summary. `missing` lists paths the caller asked about that have
   * no active card in the DB at all — worth reading those files directly.
   */
  readonly coverage: CardCoverage;
  /**
   * Human-readable explanation of what drove this selection — useful for
   * debugging selection decisions.
   */
  readonly selectionBasis: string;
  /**
   * FAIL-LOUD diagnostics. Present (non-empty) when the packet came back
   * empty BUT the store demonstrably holds cards for this repo under a
   * different repo_key — i.e. a canonical/key mismatch. Callers (CLI, runner
   * prime path) MUST surface these to a log/stderr — never silently return an
   * empty result when cards exist. Omitted when there is nothing to warn about.
   */
  readonly diagnostics?: readonly string[];
}

// ── Input ─────────────────────────────────────────────────────────────

export interface CardsForScopeInput {
  /**
   * Canonical repo identifier: the remote origin URL if available, else
   * the absolute realpath of the repo root. Used to compute the stable
   * `repoKey` — callers must never pass the friendly display name here.
   */
  readonly repoCanonical: string;
  /** Human-readable repo name (used for digest + lore queries). */
  readonly repo: string;
  /**
   * Free-text scope description — passed to FTS (tier 4) and lore search
   * (tier 5). Should describe the task or the area being changed.
   */
  readonly query: string;
  /**
   * Explicit file paths known to be in scope. Tier-1 cards are exact
   * matches; tier-2 cards match these paths as directory prefixes.
   */
  readonly paths?: ReadonlyArray<string>;
  /**
   * Additional paths the caller considers important but does not
   * guarantee are in scope (tier 3 — lower priority than `paths`).
   */
  readonly importantPaths?: ReadonlyArray<string>;
  /** Hard cap on number of cards returned. Defaults to 20. */
  readonly maxCards?: number;
  /**
   * Overall token budget (estimated as chars/4). Cards that would push
   * the total over this limit are moved to `omitted`.
   */
  readonly maxTokens?: number;
  /**
   * Per-card token budget. If a single card's estimated token count
   * exceeds this, its `tldr` is truncated to fit. The card is still
   * returned (not omitted) — truncated content is better than no content.
   */
  readonly perCardMaxTokens?: number;
}

// ── Token estimation + truncation ─────────────────────────────────────

function estimateCardTokens(card: FileCard): number {
  const chars =
    card.path.length +
    (card.tldr?.length ?? 0) +
    card.symbols.join(" ").length +
    (card.rolePrimary?.length ?? 0) +
    (card.roleTags?.join(" ").length ?? 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Apply per-card token cap by truncating `tldr`. The card is always
 * returned — we prefer truncated content to no content. Symbols and
 * mechanical fields are never truncated (they are the retrieval signal).
 */
function applyPerCardBudget(card: FileCard, perCardMaxTokens: number): FileCard {
  if (estimateCardTokens(card) <= perCardMaxTokens) return card;
  if (card.tldr === null) return card; // nothing left to truncate

  const maxChars = perCardMaxTokens * CHARS_PER_TOKEN;
  const baseChars =
    card.path.length +
    card.symbols.join(" ").length +
    (card.rolePrimary?.length ?? 0) +
    (card.roleTags?.join(" ").length ?? 0);

  if (baseChars >= maxChars) {
    // Even without tldr it exceeds the budget — drop tldr entirely.
    return { ...card, tldr: null };
  }

  const tldrBudget = maxChars - baseChars;
  const truncatedTldr =
    card.tldr.length > tldrBudget
      ? card.tldr.slice(0, Math.max(0, tldrBudget - 1)) + "…"
      : card.tldr;

  return { ...card, tldr: truncatedTldr };
}

// ── Selection helpers ─────────────────────────────────────────────────

/**
 * Build a human-readable description of what drove card selection.
 * Used in `selectionBasis` so callers can see at a glance why they got
 * what they got.
 */
function buildSelectionBasis(
  paths: ReadonlyArray<string>,
  importantPaths: ReadonlyArray<string>,
  query: string,
): string {
  const parts: string[] = [];
  if (paths.length > 0) parts.push(`${paths.length} explicit path(s) (exact + prefix)`);
  if (importantPaths.length > 0)
    parts.push(`${importantPaths.length} important path(s) (exact + prefix)`);
  if (query) parts.push(`FTS query "${query.slice(0, 60)}${query.length > 60 ? "…" : ""}"`);
  if (parts.length === 0) return "no explicit scope — digest + lore only";
  return `Selection driven by: ${parts.join("; ")}. Tiers: exact-path → path-prefix → important-path → fts → digest+lore.`;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Assemble a budgeted scope packet for agent consumption.
 *
 * The packet is safe to push directly into a prompt. It is NOT a
 * substitute for reading files — it is a guide to help agents choose
 * which files to read. The `selectionBasis` and `omitted` fields tell
 * the agent what was dropped and why, so the decision is transparent.
 *
 * GUARDRAILS:
 *   - Never reads the dispatch or crew DB.
 *   - Never fabricates content — cards that don't exist produce
 *     `coverage.missing` entries, not invented summaries.
 *   - The trust-split serving rule (in fileCards.ts) is enforced
 *     automatically: model fields are null'd unless model_status='active'.
 */
export function cardsForScope(db: Database, input: CardsForScopeInput): ScopePacket {
  if (!input.repoCanonical.trim()) {
    throw new Error("cardsForScope: repoCanonical must be non-empty");
  }
  if (!input.repo.trim()) {
    throw new Error("cardsForScope: repo must be non-empty");
  }

  const rk = computeRepoKey(input.repoCanonical);
  const maxCards = input.maxCards ?? DEFAULT_MAX_CARDS;
  const paths = input.paths ?? [];
  const importantPaths = input.importantPaths ?? [];
  const query = input.query ?? "";

  // Selection state
  // seen: path → tier (used for dedup; first tier wins = highest priority)
  const seen = new Map<string, SelectionTier>();
  const selectedCards: FileCard[] = [];
  const omitted: OmittedEntry[] = [];
  let cumulativeTokens = 0;
  let budgetHit: "maxCards" | "maxTokens" | null = null;

  function tryAddCard(card: FileCard, tier: SelectionTier): void {
    // Dedup: if we've already accepted this path at a higher tier, skip.
    if (seen.has(card.path)) return;

    if (budgetHit !== null) {
      // Budget already exhausted — record as omitted but don't stop iterating
      // (we need to continue to collect dedup info for the seen map).
      // Actually just mark omitted and return.
      omitted.push({
        path: card.path,
        reason: budgetHit === "maxCards" ? "budget-maxCards" : "budget-maxTokens",
      });
      return;
    }

    if (selectedCards.length >= maxCards) {
      budgetHit = "maxCards";
      omitted.push({ path: card.path, reason: "budget-maxCards" });
      return;
    }

    // Apply per-card token budget (truncates tldr if needed)
    const finalCard =
      input.perCardMaxTokens !== undefined
        ? applyPerCardBudget(card, input.perCardMaxTokens)
        : card;

    const cardTokens = estimateCardTokens(finalCard);

    if (input.maxTokens !== undefined && cumulativeTokens + cardTokens > input.maxTokens) {
      budgetHit = "maxTokens";
      omitted.push({ path: card.path, reason: "budget-maxTokens" });
      return;
    }

    seen.set(card.path, tier);
    selectedCards.push(finalCard);
    cumulativeTokens += cardTokens;
  }

  // ── Tier 1: exact path matches ─────────────────────────────────────
  if (paths.length > 0) {
    const tier1 = listCardsForPaths(db, rk, paths);
    for (const card of tier1) {
      tryAddCard(card, "exact-path");
    }
  }

  // ── Tier 2: path-prefix matches ────────────────────────────────────
  if (paths.length > 0) {
    const tier2 = listCardsForPathPrefixes(db, rk, paths);
    for (const card of tier2) {
      if (!seen.has(card.path)) {
        tryAddCard(card, "path-prefix");
      }
    }
  }

  // ── Tier 3: important paths (exact + prefix) ───────────────────────
  if (importantPaths.length > 0) {
    const tier3Exact = listCardsForPaths(db, rk, importantPaths);
    for (const card of tier3Exact) {
      if (!seen.has(card.path)) {
        tryAddCard(card, "important-path");
      }
    }
    const tier3Prefix = listCardsForPathPrefixes(db, rk, importantPaths);
    for (const card of tier3Prefix) {
      if (!seen.has(card.path)) {
        tryAddCard(card, "important-prefix");
      }
    }
  }

  // ── Tier 4: FTS ────────────────────────────────────────────────────
  if (query.trim()) {
    // Request more than maxCards so we have candidates to fill remaining slots.
    const ftsLimit = Math.min(maxCards * 2, 50);
    const tier4 = searchFileCards(db, rk, query, ftsLimit);
    for (const card of tier4) {
      if (!seen.has(card.path)) {
        tryAddCard(card, "fts");
      }
    }
  }

  // ── Tier 5: digest + lore ──────────────────────────────────────────
  const digest = getDigest(db, input.repo) ?? null;
  const lore: LoreSummary[] = query.trim()
    ? searchLore(db, { query, repo: input.repo, limit: DEFAULT_LORE_LIMIT })
    : [];

  // ── Coverage: paths with no active card ───────────────────────────
  const allRequestedPaths = [...paths, ...importantPaths];
  const missing = allRequestedPaths.filter((p) => {
    // Exact match: a card for this exact path was selected.
    if (seen.has(p)) return false;
    // Directory-prefix match (FIX 3): a requested DIRECTORY path (e.g.
    // "src/api") is considered COVERED if any served card is a direct or
    // transitive child (i.e. its path starts with "<p>/").  Without this
    // check, "src/api" would appear in `missing` even when "src/api/foo.ts"
    // was served via a path-prefix query, producing a spurious warning.
    const prefix = p + "/";
    for (const servedPath of seen.keys()) {
      if (servedPath.startsWith(prefix)) return false;
    }
    return true;
  });

  // ── Build selectionOrder ──────────────────────────────────────────
  const selectionOrder: SelectionEntry[] = selectedCards.map((c) => ({
    path: c.path,
    tier: seen.get(c.path) ?? ("fts" as SelectionTier),
  }));

  // ── truncationReason ─────────────────────────────────────────────
  let truncationReason: string | undefined;
  if (budgetHit === "maxCards") {
    truncationReason = `maxCards limit (${maxCards}) reached — ${omitted.length} card(s) omitted`;
  } else if (budgetHit === "maxTokens") {
    truncationReason = `maxTokens limit (${input.maxTokens!}) reached — ${omitted.length} card(s) omitted`;
  }

  const selectionBasis = buildSelectionBasis(paths, importantPaths, query);

  // FAIL LOUD: if we're about to hand back an empty card set, check whether
  // the store actually HAS cards for this repo under a different key (the
  // canonical/key-mismatch trap). If so, attach a diagnostic rather than
  // silently returning nothing.
  const diagnostics: string[] = [];
  if (selectedCards.length === 0) {
    const warn = diagnoseRepoKeyMismatch(db, rk, input.repo, input.repoCanonical);
    if (warn) diagnostics.push(warn);
  }

  return {
    cards: selectedCards,
    digest,
    lore,
    selectionOrder,
    omitted,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    coverage: {
      requested: allRequestedPaths.length,
      served: selectedCards.length,
      missing,
    },
    selectionBasis,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
