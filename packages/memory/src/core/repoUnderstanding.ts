/**
 * Repo Understanding — the shared spine the factory reads and writes.
 *
 * Two repo-scoped record types living ALONGSIDE lore (migration 005):
 *
 *   - repo_digest: exactly ONE current digest per repo — a living TLDR
 *     (overview / structure / conventions / stack). Writing a new digest
 *     supersedes the prior in place; the supersede history lives in the
 *     `events` table (kind 'digest_updated', keyed by repo) so freshness
 *     and provenance stay inspectable. A living doc with a paper trail.
 *
 *   - feature: the feature ledger, with a backlog → building → shipped
 *     lifecycle, scoped at REPO or SCOPE-NODE level. Each transition
 *     records an event (kind 'feature_*') so how a feature moved is
 *     auditable.
 *
 * GATING RATIONALE — why these do NOT route through lore's draft/approve
 * gate. Lore's gate exists because agents make *interpretive* claims
 * ("the team prefers X") that a human must ratify before other agents
 * trust them. Repo Understanding is different in kind:
 *
 *   - The digest and a feature's shipped status are FACTUAL POST-MERGE
 *     REFLECTIONS — they describe what the code now IS, produced by the
 *     onboard/merge steps that already ran against real code. There is no
 *     interpretation to ratify, so `upsertDigest` and an advance INTO
 *     `shipped` apply directly.
 *   - `addFeature` is a PROPOSAL for the backlog (a thing we might build).
 *     A backlog idea is cheap and reversible; it lands directly rather
 *     than queueing for review, because a stale backlog item costs
 *     nothing and the ledger's value is in being current.
 *
 * Keeping these OUT of lore's gating path is deliberate: they're a
 * separate record kind with their own (lighter) trust model. Routing
 * them through approve/reject would conflate "ratify an opinion" with
 * "record a fact" and would make the spine slow to update — exactly the
 * wrong tradeoff for a doc whose only job is to stay fresh.
 */
import type { Database } from "better-sqlite3";

import type { Feature, FeatureRow, FeatureStatus, RepoDigest, RepoDigestRow } from "../db/types.js";
import { newLoreId } from "./ids.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Repo names are the join key across the whole factory (digest, feature,
 * lore_repos, boundaries) — trim only, no case-folding. Mirrors
 * `normaliseRepo` in lore.ts / boundaries.ts so the same repo string
 * lines up across record kinds.
 */
function normaliseRepo(r: string): string {
  return r.trim();
}

/**
 * Scope-node names are a SOFT reference into dispatch's scope graph — we
 * store the name verbatim (trimmed) and never validate it. An empty /
 * whitespace-only node collapses to `undefined` (repo-level) so callers
 * can't accidentally create a phantom "" node distinct from "no node".
 */
function normaliseScopeNode(n: string | undefined | null): string | undefined {
  if (n === undefined || n === null) return undefined;
  const t = n.trim();
  return t.length > 0 ? t : undefined;
}

const ALLOWED_FEATURE_STATUSES: ReadonlySet<FeatureStatus> = new Set([
  "backlog",
  "building",
  "shipped",
]);

/**
 * Legal lifecycle transitions. Forward-only:
 *   backlog → building → shipped, plus the direct backlog → shipped jump
 *   (features inventoried as already-present at onboard time).
 * Anything else (e.g. shipped → backlog, building → backlog) is rejected.
 * A same-state "transition" is also illegal — `advanceFeature` is for
 * MOVING a feature; re-asserting the current status is a no-op the caller
 * shouldn't dress up as progress.
 */
const LEGAL_FEATURE_TRANSITIONS: Readonly<Record<FeatureStatus, ReadonlyArray<FeatureStatus>>> = {
  backlog: ["building", "shipped"],
  building: ["shipped"],
  shipped: [],
};

export function isLegalFeatureTransition(from: FeatureStatus, to: FeatureStatus): boolean {
  return LEGAL_FEATURE_TRANSITIONS[from].includes(to);
}

// ── Repo Digest ───────────────────────────────────────────────────────

function rowToDigest(row: RepoDigestRow): RepoDigest {
  return {
    repo: row.repo,
    overview: row.overview,
    structure: row.structure,
    conventions: row.conventions,
    stack: row.stack,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

export interface UpsertDigestInput {
  readonly repo: string;
  readonly overview: string;
  readonly structure: string;
  readonly conventions: string;
  readonly stack: string;
  /** Free text provenance: 'onboard' | 'merge:#<n>' | 'manual'. */
  readonly source: string;
}

/**
 * Write (or replace) the single current digest for a repo. There is
 * exactly one digest per repo: a second `upsertDigest` supersedes the
 * first IN PLACE. The supersede isn't silent — every write appends a
 * `digest_updated` event keyed by repo (payload carries the source) so
 * the audit trail shows when and why the digest changed, mirroring the
 * event-per-mutation discipline lore uses. Only the latest body is
 * stored; the history is in the ledger.
 *
 * Applies DIRECTLY (no draft gate) — see the module header: a digest is a
 * factual post-merge reflection produced against real code, not an
 * opinion needing ratification.
 */
export function upsertDigest(db: Database, input: UpsertDigestInput): RepoDigest {
  const repo = normaliseRepo(input.repo);
  if (!repo) throw new Error("upsertDigest: repo must be non-empty");
  const source = input.source.trim();
  if (!source) throw new Error("upsertDigest: source must be non-empty");
  const ts = nowIso();

  const existing = db.prepare("SELECT repo FROM repo_digest WHERE repo = ?").get(repo) as
    | { repo: string }
    | undefined;

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE repo_digest SET
           overview = ?, structure = ?, conventions = ?,
           stack = ?, updated_at = ?, source = ?
         WHERE repo = ?`,
      ).run(input.overview, input.structure, input.conventions, input.stack, ts, source, repo);
    } else {
      db.prepare(
        `INSERT INTO repo_digest
           (repo, overview, structure, conventions, stack, updated_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(repo, input.overview, input.structure, input.conventions, input.stack, ts, source);
    }
    // Audit trail: one event per write, keyed by repo (NOT a lore id —
    // the events table's `lore_id` column is a free string key). Payload
    // records the provenance + whether this superseded a prior digest so
    // `memory` history / the UI can show the full chain of refreshes.
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'digest_updated', ?, ?)",
    ).run(repo, ts, JSON.stringify({ repo, source, superseded: !!existing }));
  });
  tx();
  return getDigest(db, repo)!;
}

/** Fetch the current digest for a repo, or null if none has been written. */
export function getDigest(db: Database, repo: string): RepoDigest | null {
  const row = db.prepare("SELECT * FROM repo_digest WHERE repo = ?").get(normaliseRepo(repo)) as
    | RepoDigestRow
    | undefined;
  return row ? rowToDigest(row) : null;
}

// ── Feature ledger ────────────────────────────────────────────────────

function rowToFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    repo: row.repo,
    scopeNode: row.scope_node ?? undefined,
    name: row.name,
    summary: row.summary,
    status: row.status,
    area: row.area ?? undefined,
    provenance: row.provenance ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AddFeatureInput {
  readonly repo: string;
  /**
   * Optional scope-node name (soft ref to dispatch). Omit / null for a
   * repo-level feature. Whitespace-only collapses to repo-level.
   */
  readonly scopeNode?: string | null;
  readonly name: string;
  readonly summary: string;
  /**
   * Initial lifecycle status. Defaults to 'backlog' (a proposed idea).
   * Onboard inventory can land a feature directly as 'shipped' (or
   * 'building') when it's already present in the code.
   */
  readonly status?: FeatureStatus;
  readonly area?: string;
  readonly provenance?: string;
}

/**
 * Add a feature to a repo's ledger. Defaults to `backlog`. Always
 * anchored to a repo; `scopeNode` further narrows it to a sub-area when
 * provided (a SOFT reference — we never check it against dispatch's
 * scope graph). Records a `feature_added` event carrying the initial
 * status so the ledger's history starts from the right point even when a
 * feature is inventoried straight in as `shipped`.
 *
 * Applies DIRECTLY as a proposal (no draft gate) — see the module header.
 */
export function addFeature(db: Database, input: AddFeatureInput): Feature {
  const repo = normaliseRepo(input.repo);
  if (!repo) throw new Error("addFeature: repo must be non-empty");
  const name = input.name.trim();
  if (!name) throw new Error("addFeature: name must be non-empty");
  const summary = input.summary;
  const status: FeatureStatus = input.status ?? "backlog";
  if (!ALLOWED_FEATURE_STATUSES.has(status)) {
    throw new Error(
      `addFeature: status must be one of backlog | building | shipped (got ${JSON.stringify(status)})`,
    );
  }
  const scopeNode = normaliseScopeNode(input.scopeNode);
  const id = newLoreId();
  const ts = nowIso();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO feature
         (id, repo, scope_node, name, summary, status, area, provenance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      repo,
      scopeNode ?? null,
      name,
      summary,
      status,
      input.area ?? null,
      input.provenance ?? null,
      ts,
      ts,
    );
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'feature_added', ?, ?)",
    ).run(id, ts, JSON.stringify({ repo, scopeNode: scopeNode ?? null, status }));
  });
  tx();
  return getFeature(db, id)!;
}

export function getFeature(db: Database, id: string): Feature | null {
  const row = db.prepare("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | undefined;
  return row ? rowToFeature(row) : null;
}

/**
 * Distinguishes the two ways `advanceFeature` can refuse, so the MCP/CLI
 * layers can give a precise message without a second lookup.
 */
export type AdvanceFeatureRefusal = "unknown_id" | "illegal_transition";

export class AdvanceFeatureError extends Error {
  readonly reason: AdvanceFeatureRefusal;
  constructor(reason: AdvanceFeatureRefusal, message: string) {
    super(message);
    this.name = "AdvanceFeatureError";
    this.reason = reason;
  }
}

/**
 * Move a feature to a new lifecycle status, enforcing the legal forward
 * transitions (backlog → building → shipped, plus backlog → shipped).
 * Records a `feature_advanced` event with the from/to pair so the
 * ledger's history shows the path a feature took.
 *
 * Throws `AdvanceFeatureError`:
 *   - `unknown_id` when the feature doesn't exist
 *   - `illegal_transition` for any backward / same-state / unknown move
 *     (e.g. shipped → backlog). The current row is never mutated.
 *
 * The advance INTO `shipped` is a factual post-merge reflection (the
 * thing is now in the product) and applies directly — see the module
 * header for why this isn't routed through lore's approve gate.
 */
export function advanceFeature(db: Database, id: string, toStatus: FeatureStatus): Feature {
  if (!ALLOWED_FEATURE_STATUSES.has(toStatus)) {
    throw new AdvanceFeatureError(
      "illegal_transition",
      `advanceFeature: '${toStatus}' is not a valid status`,
    );
  }
  const current = db.prepare("SELECT status FROM feature WHERE id = ?").get(id) as
    | { status: FeatureStatus }
    | undefined;
  if (!current) {
    throw new AdvanceFeatureError("unknown_id", `advanceFeature: no feature with id '${id}'`);
  }
  if (!isLegalFeatureTransition(current.status, toStatus)) {
    throw new AdvanceFeatureError(
      "illegal_transition",
      `advanceFeature: ${current.status} → ${toStatus} is not a legal transition`,
    );
  }
  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare("UPDATE feature SET status = ?, updated_at = ? WHERE id = ?").run(toStatus, ts, id);
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'feature_advanced', ?, ?)",
    ).run(id, ts, JSON.stringify({ from: current.status, to: toStatus }));
  });
  tx();
  return getFeature(db, id)!;
}

export interface ListFeaturesOptions {
  readonly status?: FeatureStatus;
  /**
   * Filter to a specific scope-node. `undefined` = no node filter (all
   * features in the repo, repo-level AND node-level). To list only
   * repo-level features, pass `scopeNode: null` — distinct from omitting
   * it, which returns everything.
   */
  readonly scopeNode?: string | null;
}

/**
 * List a repo's features, optionally narrowed by `status` and/or
 * `scopeNode`. Always scoped to one repo (the ledger is per-repo).
 *
 * Node addressing:
 *   - omit `scopeNode`        → every feature in the repo
 *   - `scopeNode: 'auth'`     → only features on the 'auth' node
 *   - `scopeNode: null`       → only repo-level features (scope_node IS NULL)
 *
 * Ordered status (backlog → building → shipped) then name, so the CLI /
 * UI can render a stable, grouped list without re-sorting.
 */
export function listFeatures(
  db: Database,
  repo: string,
  opts: ListFeaturesOptions = {},
): Feature[] {
  const filters: string[] = ["repo = ?"];
  const params: Array<string> = [normaliseRepo(repo)];

  if (opts.status !== undefined) {
    if (!ALLOWED_FEATURE_STATUSES.has(opts.status)) {
      throw new Error(
        `listFeatures: status must be one of backlog | building | shipped (got ${JSON.stringify(opts.status)})`,
      );
    }
    filters.push("status = ?");
    params.push(opts.status);
  }

  if (opts.scopeNode === null) {
    filters.push("scope_node IS NULL");
  } else if (opts.scopeNode !== undefined) {
    const node = normaliseScopeNode(opts.scopeNode);
    if (node === undefined) {
      // An empty / whitespace node string means "repo-level".
      filters.push("scope_node IS NULL");
    } else {
      filters.push("scope_node = ?");
      params.push(node);
    }
  }

  const rows = db
    .prepare(
      `SELECT * FROM feature
       WHERE ${filters.join(" AND ")}
       ORDER BY
         CASE status WHEN 'backlog' THEN 0 WHEN 'building' THEN 1 ELSE 2 END,
         name`,
    )
    .all(...params) as FeatureRow[];
  return rows.map(rowToFeature);
}
