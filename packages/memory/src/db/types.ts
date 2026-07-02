/**
 * Shared types between the DB layer, core operations, the CLI, and the MCP
 * server. Kept narrow on purpose — surface area changes are migrations.
 *
 * Vocabulary:
 *   - "lore"   = a single record (a convention, decision, gotcha, lesson)
 *   - "draft"  = agent-suggested, not yet human-approved
 *   - "active" = canonical; visible to search by default
 *   - "deprecated" / "superseded" = retired; hidden by default
 *   - "restricted" = retrieval guard (excluded unless explicitly opted in).
 *                    NOT a DLP/access-control mechanism; document accordingly.
 */

export type LoreStatus = "draft" | "active" | "deprecated" | "superseded";
export type LoreConfidence = "low" | "medium" | "high";

/**
 * What KIND of knowledge a record captures — the product-intent classifier
 * that lets recall be aimed at "why" (decisions / requirements / non-goals)
 * versus "how" (conventions / gotchas). A closed enum, not free text, so a
 * consumer (e.g. the context packet's productContext section) can filter on
 * it deterministically:
 *
 *   - "decision"    — a durable choice + its rationale (why we built it this way).
 *   - "requirement" — a product need / must-hold behaviour the work exists to serve.
 *   - "non-goal"    — something deliberately OUT of scope (guards against scope creep).
 *   - "convention"  — a "how we do it here" pattern not obvious from the code.
 *   - "gotcha"      — a trap that wasted time and is likely to bite again.
 *   - "other"       — the fallback for records that predate the enum or don't fit.
 *
 * `decision | requirement | non-goal` are the PRODUCT-INTENT kinds; the
 * productContext packet section surfaces those specifically.
 */
export type LoreKind = "decision" | "requirement" | "non-goal" | "convention" | "gotcha" | "other";

/** Runtime-checkable list of every valid {@link LoreKind}. */
export const LORE_KINDS: readonly LoreKind[] = [
  "decision",
  "requirement",
  "non-goal",
  "convention",
  "gotcha",
  "other",
] as const;

/** The subset of kinds that carry PRODUCT INTENT (the "why", not the "how"). */
export const PRODUCT_INTENT_KINDS: readonly LoreKind[] = [
  "decision",
  "requirement",
  "non-goal",
] as const;

export interface LoreRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author: string | null;
  readonly team: string | null;
  readonly status: LoreStatus;
  /** Product-intent classifier (migration 009). Defaults to 'other'. */
  readonly kind: LoreKind;
  readonly source: string | null;
  readonly review_after: string | null;
  readonly confidence: LoreConfidence;
  readonly superseded_by: string | null;
  readonly restricted: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_verified_at: string | null;
  /**
   * JSON-encoded array of lore ids that this record explicitly
   * challenges (counter-claim). NULL on every record that isn't a
   * counter-record — never the empty array `"[]"`. See ADR-003.
   */
  readonly conflicts_with: string | null;
}

/**
 * Full Lore — returned by getLore() and the MCP `get_lore` tool. This is
 * the only shape that includes the full `body`. Search deliberately uses
 * LoreSummary to keep agent context cheap.
 */
export interface Lore {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  readonly status: LoreStatus;
  /** Product-intent classifier (see {@link LoreKind}). */
  readonly kind: LoreKind;
  readonly source?: string;
  readonly reviewAfter?: string;
  readonly confidence: LoreConfidence;
  readonly supersededBy?: string;
  readonly restricted: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
  /**
   * Explicit team-ratified disagreement: ids of canonical records this
   * record challenges. Populated only on counter-records created via
   * `reportConflict`; `undefined` on every other record (NOT `[]` — the
   * absence is the meaningful state). Distinct from the runtime
   * `possibleConflicts` heuristic on LoreSummary, which is shared-scope
   * overlap detection. See ADR-003.
   */
  readonly conflictsWith?: ReadonlyArray<string>;
}

/**
 * Brief-by-default projection used by search. Full body deliberately
 * omitted so an LLM context isn't ballooned by an archive on every hit.
 * Use `get_lore(id)` to fetch the body on demand.
 *
 * Includes the trust-relevant metadata (status / source / confidence /
 * stale) so the agent doesn't need a second tool call to know whether
 * to trust a result.
 */
export interface LoreSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly author?: string;
  readonly team?: string;
  readonly status: LoreStatus;
  /** Product-intent classifier (see {@link LoreKind}). */
  readonly kind: LoreKind;
  readonly source?: string;
  readonly confidence: LoreConfidence;
  readonly restricted: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
  /** Set true when review_after is in the past. UI surfaces a warning. */
  readonly stale: boolean;
  /** FTS rank, lower = more relevant. Undefined when no query was given. */
  readonly score?: number;
  /**
   * IDs of other `active` records in the SAME search response that share
   * at least one repo AND at least one tag with this one — i.e. records
   * that POSSIBLY conflict. This is an overlap heuristic, not contradiction
   * detection: two records sharing scope might be complementary or might
   * disagree, and a human / agent has to read both to know. Populated by
   * `searchLore` after the result set is assembled; intentionally scoped
   * to the current response. Empty / omitted when nothing qualifies.
   */
  readonly possibleConflicts?: ReadonlyArray<string>;
  /**
   * Same `conflictsWith` semantics as on `Lore` — explicit counter-claim
   * link from `reportConflict`. Surfaced in search so the agent (and
   * the CLI renderer) can flag counter-records without a separate
   * round trip. `undefined` on non-counter records.
   */
  readonly conflictsWith?: ReadonlyArray<string>;
}

export interface SearchOptions {
  readonly query?: string;
  readonly repo?: string;
  /**
   * Single tag or a list of tags. ANY-of semantics: a record matches if
   * it carries at least one of the requested tags. (AND semantics is
   * deferred — most callers want "show me anything tagged X or Y".)
   */
  readonly tag?: string | ReadonlyArray<string>;
  /** ISO timestamp; only lore updated on/after this is returned. */
  readonly updatedAfter?: string;
  /** Default false. */
  readonly includeRestricted?: boolean;
  /** Default false; agents shouldn't see unreviewed material by default. */
  readonly includeDrafts?: boolean;
  /** Default false. */
  readonly includeDeprecated?: boolean;
  /** Default false. */
  readonly includeSuperseded?: boolean;
  /**
   * Opt-in prefix match. When true, every query token of 3+ chars is
   * matched as a prefix (FTS5 `"token"*`), so "timez" hits "timezone".
   * Off by default because prefix queries can match aggressively — a
   * three-character prefix can hit half the index.
   */
  readonly prefix?: boolean;
  readonly limit?: number;
}

/**
 * Both `addLore` (status=active) and `suggestLore` (status=draft) share
 * the same input shape. The caller decides the default by which entry
 * point they call.
 */
export interface AddLoreInput {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  /** Product-intent classifier; defaults to 'other' when omitted. */
  readonly kind?: LoreKind;
  readonly source?: string;
  readonly reviewAfter?: string;
  readonly confidence?: LoreConfidence;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly restricted?: boolean;
}

/**
 * Partial-update shape for `updateLore`. Any field set is applied; tags
 * and repos when set REPLACE the existing list (caller passes the full
 * desired set). Status is intentionally NOT updatable here — use
 * approveLore / deprecateLore / supersedeLore for lifecycle transitions.
 */
export interface UpdateLoreInput {
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly author?: string;
  readonly team?: string;
  /** Product-intent classifier; when set, re-classifies the record. */
  readonly kind?: LoreKind;
  readonly source?: string;
  readonly reviewAfter?: string | null;
  readonly confidence?: LoreConfidence;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly restricted?: boolean;
}

// ── Boundaries (cross-repo interaction map) ───────────────────────────

/**
 * A boundary edge records that a repo `provides` (owns / produces) or
 * `consumes` (depends on) a named contract — an event, endpoint, queue,
 * table, RPC, etc. Aggregated across repos via `sync`, the edges form a
 * dependency map: changing a contract in one app, the `consumes` edges
 * tell you which other apps it affects.
 *
 *   - "provides" = this repo is the owner / source of truth for the
 *     contract (the producer of an event, the server of an endpoint).
 *   - "consumes" = this repo depends on it (subscribes, calls, reads).
 */
export type BoundaryRole = "provides" | "consumes";

/**
 * Boundary lifecycle. Same trust spine as lore: agent-declared edges
 * land as `draft` (hidden from the default map until a human ratifies);
 * `active` is canonical; `deprecated` is retired but still findable so
 * historical edges aren't silently lost.
 */
export type BoundaryStatus = "draft" | "active" | "deprecated";

export interface BoundaryRow {
  readonly id: string;
  readonly repo: string;
  /** Normalised contract key (lowercased / hyphenated; see normaliseContract). */
  readonly contract: string;
  readonly role: BoundaryRole;
  /** Optional classifier: event | endpoint | queue | table | rpc | other. */
  readonly kind: string | null;
  readonly status: BoundaryStatus;
  /** Free-text note: which field/version/path, migration caveats, etc. */
  readonly detail: string | null;
  readonly source: string | null;
  readonly author: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Boundary {
  readonly id: string;
  readonly repo: string;
  readonly contract: string;
  readonly role: BoundaryRole;
  readonly kind?: string;
  readonly status: BoundaryStatus;
  readonly detail?: string;
  readonly source?: string;
  readonly author?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Repo Understanding (digest + feature ledger) ──────────────────────

/**
 * Where a repo digest came from. Stored as free text (not a closed union
 * at the DB level) because the factory's merge step stamps an arbitrary
 * PR ref (`merge:#<n>`), but the three shapes the producers actually
 * write are:
 *
 *   - "onboard"    — the cold-start onboarding pass inventoried the repo
 *   - "merge:#<n>" — a post-merge reflection refreshed it (n = PR number)
 *   - "manual"     — a human edited it directly
 *
 * Consumers (idle/UI) render this alongside `updatedAt` as the freshness
 * + provenance line, so a stale or low-provenance digest is visible.
 */
export type DigestSource = "onboard" | `merge:#${number}` | "manual";

export interface RepoDigestRow {
  readonly repo: string;
  readonly overview: string;
  readonly structure: string;
  readonly conventions: string;
  readonly stack: string;
  readonly updated_at: string;
  readonly source: string;
}

/**
 * The single CURRENT digest for a repo — a living TLDR the factory's
 * onboard/merge steps produce and the idle/UI steps consume. Exactly one
 * per repo (the `repo` is the primary key); writing a new one supersedes
 * the prior in place. The supersede history lives in the `events` table
 * (kind `digest_updated`, keyed by repo) so freshness/provenance stays
 * inspectable even though only the latest body is stored.
 */
export interface RepoDigest {
  readonly repo: string;
  /** TLDR prose: what this repo is and does. */
  readonly overview: string;
  /** Key modules / dirs and the role each plays. */
  readonly structure: string;
  /** Stack + the patterns a contributor should follow. */
  readonly conventions: string;
  /** Headline tech stack (languages / frameworks / datastores). */
  readonly stack: string;
  readonly updatedAt: string;
  readonly source: string;
}

/**
 * Feature lifecycle:
 *   - backlog  — an idea, or inventoried-but-not-built
 *   - building — in flight
 *   - shipped  — in the product now
 *
 * Legal transitions: backlog → building → shipped, plus the direct
 * backlog → shipped jump (features inventoried as already-present at
 * onboard time). No transition ever moves a feature backwards.
 */
export type FeatureStatus = "backlog" | "building" | "shipped";

export interface FeatureRow {
  readonly id: string;
  readonly repo: string;
  readonly scope_node: string | null;
  readonly name: string;
  readonly summary: string;
  readonly status: FeatureStatus;
  readonly area: string | null;
  readonly provenance: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A single feature in a repo's feature ledger. Scoped at REPO level by
 * default; `scopeNode` narrows it to a sub-area (e.g. the "auth" node)
 * when set. The scope graph lives in dispatch — `scopeNode` is a SOFT
 * reference (a node name we store, never cross-validate). `undefined`
 * means repo-level.
 */
export interface Feature {
  readonly id: string;
  readonly repo: string;
  /** Optional scope-node name; `undefined` = repo-level. Soft ref to dispatch. */
  readonly scopeNode?: string;
  readonly name: string;
  readonly summary: string;
  readonly status: FeatureStatus;
  /** Optional free-text path/area hint (e.g. 'src/auth'). */
  readonly area?: string;
  /** Backlog-idea source, or the epic/ticket ref once building/shipped. */
  readonly provenance?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── File Cards (retrieval-aid index, migration 006) ───────────────────

/**
 * Mechanical validity of a file card. Applies to the structural fields
 * (path, content_hash, loc, symbols, source). These are served whenever
 * card_status = 'active', regardless of model_status.
 *
 *   - active  — mechanical fields are valid; serve them.
 *   - stale   — card exists but the file has changed since the card was
 *               written (detected by content_hash mismatch or a newer
 *               synced_commit). Still searchable; surfaced with a warning.
 *   - shadow  — card was invalidated by a mechanical gate failure (path
 *               missing, source outside read roots, secret pattern matched,
 *               etc.). Not served in active queries.
 */
export type CardStatus = "active" | "stale" | "shadow";

/**
 * Validity of the model-generated summary fields (tldr, role_primary,
 * role_tags). Served ONLY when model_status = 'active'. A card whose
 * mechanical fields are valid but whose summary failed validation still
 * serves its mechanical half — callers must check both statuses.
 *
 *   - active             — summary passed all deterministic gates; serve it.
 *   - failed_validation  — summary failed a gate (bad symbols, secret text,
 *                          tldr over cap, etc.); validation_error carries why.
 *   - absent             — no summary has been written yet (freshly inserted
 *                          card, or the model run was skipped).
 */
export type ModelStatus = "active" | "failed_validation" | "absent";

/**
 * Raw DB row for a file card. JSON columns (symbols, role_tags) are stored
 * as strings; parsed into arrays by `rowToFileCard`. Mirrors the snake_case
 * column names exactly so better-sqlite3 can bind without mapping.
 */
export interface FileCardRow {
  readonly id: string;
  readonly repo_key: string;
  /** Normalised canonical (host/owner/repo or path) — migration 007. Null on pre-007 rows. */
  readonly canonical: string | null;
  readonly repo: string;
  readonly path: string;
  readonly content_hash: string;
  readonly loc: number;
  /** JSON-encoded string[] — exported symbol names, class names, route patterns, etc. */
  readonly symbols: string;
  readonly synced_commit: string | null;
  readonly source: string;
  readonly tldr: string | null;
  readonly role_primary: string | null;
  /** JSON-encoded string[] or null. */
  readonly role_tags: string | null;
  readonly card_status: CardStatus;
  readonly model_status: ModelStatus;
  readonly validated_at: string | null;
  readonly validation_error: string | null;
  readonly model: string | null;
  readonly prompt_version: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Public file card shape returned by core functions. camelCase, JSON
 * arrays parsed. Trust-split serving is applied by `getFileCard`:
 *   - mechanical fields always present when card_status = 'active'.
 *   - tldr / rolePrimary / roleTags are null when model_status ≠ 'active',
 *     even if the underlying row has a value — callers must never bypass
 *     this serving rule by querying the DB directly.
 */
export interface FileCard {
  readonly id: string;
  readonly repoKey: string;
  /** Normalised canonical the key was derived from (migration 007). Undefined on pre-007 rows. */
  readonly canonical?: string;
  readonly repo: string;
  readonly path: string;
  readonly contentHash: string;
  readonly loc: number;
  /** Parsed symbols array (exported names, classes, routes, test titles, etc.). */
  readonly symbols: ReadonlyArray<string>;
  readonly syncedCommit?: string;
  readonly source: string;
  /**
   * Model-generated one-liner. Served only when model_status = 'active'.
   * null otherwise — even if the row has a tldr value. This is the
   * trust-split serving rule; it is non-negotiable.
   */
  readonly tldr: string | null;
  /** Primary role label (e.g. 'domain', 'api', 'test', 'config'). null when model not active. */
  readonly rolePrimary: string | null;
  /** Role tags array. null when model not active. */
  readonly roleTags: ReadonlyArray<string> | null;
  readonly cardStatus: CardStatus;
  readonly modelStatus: ModelStatus;
  readonly validatedAt?: string;
  readonly validationError?: string;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Raw DB row for repo_sync. */
export interface RepoSyncRow {
  readonly repo_key: string;
  /** Normalised canonical — migration 007. Null on pre-007 rows. */
  readonly canonical: string | null;
  readonly repo: string;
  readonly synced_commit: string;
  readonly updated_at: string;
}

/**
 * The watermark record for a repo — records the git commit at which
 * the last full onboard scan completed. Used by Phase-2 freshness
 * loop to detect which files changed since the last scan.
 */
export interface RepoSync {
  readonly repoKey: string;
  /** Normalised canonical (migration 007). Undefined on pre-007 rows. */
  readonly canonical?: string;
  readonly repo: string;
  readonly syncedCommit: string;
  readonly updatedAt: string;
}
