/**
 * Crew's boundary onto Memory (durable, ratified knowledge).
 *
 * Crew calls Memory during context assembly to enrich a packet with
 * relevant ratified records, and after work completion to *suggest* (never
 * approve) new durable knowledge. The MVP ships a `NullMemoryClient` that
 * returns nothing; real wiring lands later.
 */

export interface LoreRecord {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  recordType: string;
}

export interface LoreSearchQuery {
  tags?: string[];
  text?: string;
  repoName?: string;
  limit?: number;
}

export interface LoreSuggestionInput {
  title: string;
  summary: string;
  tags?: string[];
  sourceTicketId?: string;
}

export interface LoreSuggestionResult {
  suggestionId: string;
  status: "draft";
}

/**
 * A Repo Digest — the agent's honest, persisted SUMMARY of a repo (a map, not the
 * territory). Written via Memory's `update_repo_digest` (upsert by `repo`).
 * Produced by the onboarding scan and persisted with its provenance (`source`).
 */
export interface RepoDigestInput {
  /** Repo identity the digest is keyed on (upsert key on the Memory side). */
  repo: string;
  /** TLDR of what the repo does. */
  overview: string;
  /** Key modules/dirs and their role. */
  structure: string;
  /** Stack + the patterns/conventions agents should follow here. */
  conventions: string;
  /** Detected stack label (e.g. "typescript-react"), or null when unknown. */
  stack: string | null;
  /** Provenance of the digest (e.g. "onboard"). */
  source: string;
}

/** Lifecycle status of an inventoried feature. */
export type FeatureStatus = "backlog" | "building" | "shipped";

/**
 * One existing user-facing feature inventoried during onboarding. Written via
 * Memory's `add_feature`. `scopeNode` is a SOFT name reference to a scope node
 * (the scope graph lives in Dispatch); it is omitted when the feature is not
 * clearly owned by a sub-area.
 */
export interface FeatureInput {
  repo: string;
  name: string;
  summary: string;
  status: FeatureStatus;
  /** Area/category label (e.g. "onboarding", "safety"). */
  area: string;
  /** Where this record came from (e.g. "onboard"). */
  provenance: string;
  /** Soft name reference to an owning scope node, when one clearly applies. */
  scopeNode?: string;
}

/** A feature already recorded in Memory (used to de-dupe on re-onboard). */
export interface ExistingFeature {
  repo: string;
  name: string;
}

/**
 * A feature row read from the memory ledger with enough detail to pick a
 * candidate and brief a decomposer: identity, lifecycle status, and (when the
 * server provides it) a creation timestamp + priority used for ordering. Read
 * via Memory's `list_features(repo, { status })`.
 */
export interface BacklogFeature {
  /** Stable feature id — the handle passed to `advance_feature`. */
  id: string;
  repo: string;
  name: string;
  summary: string;
  status: FeatureStatus;
  /** Optional priority (lower = more urgent); absent when the server omits it. */
  priority?: number;
  /** ISO-8601 creation timestamp; absent when the server omits it. */
  createdAt?: string;
}

/** Result of advancing a feature's lifecycle status via `advance_feature`. */
export interface AdvanceFeatureResult {
  id: string;
  status: FeatureStatus;
}

export interface RepoDigestResult {
  repo: string;
  /** Whether this write created a new digest or updated an existing one. */
  status: "created" | "updated";
}

export interface FeatureResult {
  /** Identifier of the feature record, when the server returns one. */
  featureId: string;
  /** "added" for a new record, "skipped" when de-duped against an existing one. */
  status: "added" | "skipped";
}

export interface MemoryClient {
  searchLore(query: LoreSearchQuery): LoreRecord[];
  suggestLore(input: LoreSuggestionInput): LoreSuggestionResult;
}

/**
 * No-op Memory for local MVP and tests. Returns no records and accepts
 * suggestions without persisting them — preserving the "suggest, never approve"
 * contract while keeping the system runnable offline.
 */
export class NullMemoryClient implements MemoryClient {
  searchLore(_query: LoreSearchQuery): LoreRecord[] {
    return [];
  }

  suggestLore(_input: LoreSuggestionInput): LoreSuggestionResult {
    return { suggestionId: "null-lore-suggestion", status: "draft" };
  }
}

/**
 * In-memory Memory used by tests that need the packet to contain lore.
 * Seeded records are filtered by tag/repo so packet relevance can be asserted.
 */
export class StubMemoryClient implements MemoryClient {
  readonly suggestions: LoreSuggestionInput[] = [];
  constructor(private readonly records: LoreRecord[] = []) {}

  searchLore(query: LoreSearchQuery): LoreRecord[] {
    const wantedTags = query.tags ?? [];
    const matches = this.records.filter((record) => {
      if (wantedTags.length === 0) return true;
      return record.tags.some((tag) => wantedTags.includes(tag));
    });
    return typeof query.limit === "number" ? matches.slice(0, query.limit) : matches;
  }

  suggestLore(input: LoreSuggestionInput): LoreSuggestionResult {
    this.suggestions.push(input);
    return { suggestionId: `stub-${this.suggestions.length}`, status: "draft" };
  }
}
