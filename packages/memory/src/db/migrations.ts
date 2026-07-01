import type { Database } from "better-sqlite3";

/**
 * Each migration is a pair: { id, up }. The migration framework records
 * applied IDs in a `migrations` table so we can replay forwards safely.
 * Migrations are append-only — never rewrite history; add a new one.
 */
export interface Migration {
  readonly id: string;
  readonly up: (db: Database) => void;
}

/**
 * Thrown when the database on disk has migrations applied that THIS binary
 * doesn't know about — i.e. it was written by a newer memory. Refusing
 * to open is deliberate: the docs endorse a team-shared DB on a synced
 * volume, so an older binary could otherwise write against a schema it
 * doesn't understand and corrupt newer data. Distinguished by `code` so
 * entry points can print the remediation message instead of a stack trace.
 */
export class DatabaseTooNewError extends Error {
  readonly code = "MEMORY_DB_TOO_NEW";
  constructor(readonly unknownMigrations: ReadonlyArray<string>) {
    super(
      "this lore database was written by a newer version of memory.\n" +
        `  It has migrations this version doesn't recognise: ${unknownMigrations.join(", ")}.\n` +
        "  Upgrade to the latest release before opening it:\n" +
        "    npm i -g memory-mcp@latest\n" +
        "  (Refusing to open — an older schema could corrupt newer data.)",
    );
    this.name = "DatabaseTooNewError";
  }
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: "001-initial-schema",
    up(db) {
      db.exec(`
        CREATE TABLE lore (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          summary            TEXT NOT NULL,
          body               TEXT NOT NULL,
          author             TEXT,
          team               TEXT,
          -- R1+ lifecycle: 'draft' (agent-created, awaiting human approval),
          -- 'active' (canonical), 'deprecated' (still findable with flag,
          -- but not surfaced by default), 'superseded' (replaced — see
          -- superseded_by). Default is 'active' because the migration
          -- targets the human CLI; the suggest_lore MCP tool overrides to
          -- 'draft' explicitly at write time.
          status             TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('draft','active','deprecated','superseded')),
          -- Source / provenance URL: PR, ADR, ticket, incident permalink.
          -- A note without a source is treated as lower-trust.
          source             TEXT,
          -- ISO date string. When set + in the past, search marks the
          -- result as stale and surfaces a warning.
          review_after       TEXT,
          -- Subjective trust signal. Default 'medium' so agents that
          -- suggest_lore without specifying don't claim authority.
          confidence         TEXT NOT NULL DEFAULT 'medium'
            CHECK (confidence IN ('low','medium','high')),
          -- When non-null, this lore record is replaced by another id.
          -- Hidden from default search; surfaces only via getLore() or
          -- includeSuperseded flag.
          superseded_by      TEXT,
          -- Retrieval guard, not data-loss-prevention. Excluded from
          -- search unless includeRestricted is explicitly passed.
          restricted         INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          last_verified_at   TEXT
        );

        CREATE TABLE lore_repos (
          lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
          repo    TEXT NOT NULL,
          PRIMARY KEY (lore_id, repo)
        );
        CREATE INDEX idx_lore_repos_repo ON lore_repos(repo);

        CREATE TABLE lore_tags (
          lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
          tag     TEXT NOT NULL,
          PRIMARY KEY (lore_id, tag)
        );
        CREATE INDEX idx_lore_tags_tag ON lore_tags(tag);

        CREATE TABLE events (
          rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
          lore_id   TEXT,
          kind      TEXT NOT NULL,
          ts        TEXT NOT NULL,
          payload   TEXT
        );
        CREATE INDEX idx_events_lore_ts ON events(lore_id, ts);

        -- Full-text search across title / summary / body. FTS maintenance
        -- is done in TypeScript (see core/lore.ts) rather than via SQL
        -- triggers — predictable, debuggable, no FTS5 'delete'-magic
        -- gotchas when WAL + transactions overlap.
        CREATE VIRTUAL TABLE lore_fts USING fts5(
          title, summary, body,
          tokenize = 'porter unicode61'
        );
      `);
    },
  },
  {
    id: "002-conflicts-with",
    up(db) {
      // R3+ — team-ratified disagreement primitive. `report_conflict`
      // creates a DRAFT counter-record whose `conflicts_with` column
      // points back at the canonical record being challenged. JSON-
      // encoded id array (or NULL). Decoded into `Lore.conflictsWith`
      // by rowToLore. Migration is append-only; existing rows stay
      // NULL (existing semantics unchanged). See ADR-003.
      db.exec(`
        ALTER TABLE lore ADD COLUMN conflicts_with TEXT;
      `);
    },
  },
  {
    id: "003-absence-markers",
    up(db) {
      // Verified-absence: record "we checked, the team has no policy
      // on this — don't re-search for N days". When search_lore
      // returns zero hits AND a matching marker is active, the
      // response includes the marker so the next agent knows it's an
      // acknowledged gap, not an oversight. Low-stakes, no review
      // gate, self-expiring — distinct from drafts.
      db.exec(`
        CREATE TABLE absence_markers (
          id            TEXT PRIMARY KEY,
          -- Normalised at write time: trim → lowercase → split on
          -- whitespace → sort tokens → join with single space. Two
          -- queries differing only by word order share a marker.
          query         TEXT NOT NULL,
          repo          TEXT,
          reason        TEXT NOT NULL,
          recorded_at   TEXT NOT NULL,
          expires_at    TEXT NOT NULL,
          recorded_by   TEXT NOT NULL
        );
        CREATE INDEX idx_absence_query ON absence_markers(query);
        CREATE INDEX idx_absence_expires ON absence_markers(expires_at);
      `);
    },
  },
  {
    id: "004-boundaries",
    up(db) {
      // Cross-repo interaction map. Each row is a directed edge: a repo
      // `provides` or `consumes` a named contract (event / endpoint /
      // queue / table / rpc). Aggregated across repos (via sync), the
      // edges answer "if I change this contract, who does it affect?".
      //
      // Same trust spine as lore: agent-declared edges land as 'draft'
      // and a human ratifies them to 'active'. 'deprecated' retires an
      // edge without losing the history. The (repo, contract, role)
      // triple is unique — one canonical edge per direction per repo —
      // so re-declaring updates in place rather than duplicating.
      db.exec(`
        CREATE TABLE boundaries (
          id          TEXT PRIMARY KEY,
          repo        TEXT NOT NULL,
          contract    TEXT NOT NULL,
          role        TEXT NOT NULL
            CHECK (role IN ('provides','consumes')),
          kind        TEXT,
          status      TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('draft','active','deprecated')),
          detail      TEXT,
          source      TEXT,
          author      TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (repo, contract, role)
        );
        CREATE INDEX idx_boundaries_contract ON boundaries(contract);
        CREATE INDEX idx_boundaries_repo ON boundaries(repo);
      `);
    },
  },
  {
    id: "005-repo-understanding",
    up(db) {
      // Repo Understanding — the shared spine the factory's onboard/merge
      // steps produce and the idle/UI steps consume. Two repo-scoped record
      // types living ALONGSIDE lore (not routed through its draft/approve
      // gate — see core/repoUnderstanding.ts for the gating rationale).
      //
      // repo_digest: exactly one CURRENT digest per repo (repo is the
      // primary key — writing a new one supersedes the prior in place). The
      // audit trail lives in `events` (kind 'digest_updated', keyed by repo)
      // so freshness/provenance stays inspectable even though only the
      // latest body is stored. A living doc with a paper trail.
      //
      // feature: the per-repo feature ledger with a backlog→building→shipped
      // lifecycle. One row per feature id; each transition records an event
      // (kind 'feature_*') so the history of how a feature moved is auditable.
      db.exec(`
        CREATE TABLE repo_digest (
          repo         TEXT PRIMARY KEY,
          overview     TEXT NOT NULL,
          structure    TEXT NOT NULL,
          conventions  TEXT NOT NULL,
          stack        TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          -- Free text provenance: 'onboard' | 'merge:#<n>' | 'manual'.
          -- Kept as free text (not a CHECK) because the factory's merge
          -- step needs to stamp an arbitrary PR ref and we don't want a
          -- schema migration every time a new producer appears.
          source       TEXT NOT NULL
        );

        CREATE TABLE feature (
          id           TEXT PRIMARY KEY,
          repo         TEXT NOT NULL,
          -- OPTIONAL scope-node the feature belongs to (a sub-area of the
          -- repo, e.g. 'auth'). NULL = the feature is repo-level. This is a
          -- SOFT reference: the scope graph itself lives in dispatch (the
          -- control plane); we only STORE the node name here and never
          -- cross-validate against dispatch. A feature is always anchored
          -- to a repo; scope_node further narrows it when set.
          scope_node   TEXT,
          name         TEXT NOT NULL,
          summary      TEXT NOT NULL,
          -- Lifecycle: backlog (an idea / inventoried-but-not-built),
          -- building (in flight), shipped (in the product now).
          status       TEXT NOT NULL DEFAULT 'backlog'
            CHECK (status IN ('backlog','building','shipped')),
          -- Optional scope / path hint (e.g. 'src/auth', 'billing').
          area         TEXT,
          -- Free text: source of a backlog idea, or the epic / ticket ref
          -- once building / shipped.
          provenance   TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX idx_feature_repo ON feature(repo);
        CREATE INDEX idx_feature_repo_status ON feature(repo, status);
        -- Node-scoped lookups (listFeatures filtered by scope_node) and
        -- the repo+node+status combination the idle/UI consumers read.
        CREATE INDEX idx_feature_repo_node ON feature(repo, scope_node);
      `);
    },
  },
  {
    id: "006-file-cards",
    up(db) {
      // File Cards — retrieval-aid index (see plan moonlit-dazzling-nebula).
      //
      // A file card is a HEURISTIC summary of one file in a repo. It helps
      // agents choose what to read; it is NOT authoritative. Agents must
      // read the actual file before editing.
      //
      // Trust split (non-negotiable; see plan §split-trust):
      //   - card_status  ∈ active|stale|shadow — mechanical validity gate.
      //     Mechanical fields (path, content_hash, loc, symbols, source) are
      //     served whenever card_status = 'active'.
      //   - model_status ∈ active|failed_validation|absent — summary validity.
      //     tldr / role_* fields are served ONLY when model_status = 'active'.
      //     A card with valid mechanical data but a failed summary still serves
      //     its mechanical half — callers must handle both statuses independently.
      //
      // repo_key — stable sha256 of the canonical path or remote URL (NOT
      // the friendly display name). Insulates the key from renames and
      // multi-worktree clashes; `repo` carries the display string separately.
      //
      // file_card_fts — TS-maintained virtual table (same discipline as
      // lore_fts: no SQL triggers, debuggable, no FTS5 'delete'-magic
      // gotchas when WAL + transactions overlap). symbols_fts is a flat
      // space-joined derivation of the symbols JSON array.
      //
      // repo_sync — one row per repo key recording the last synced commit
      // (Phase-2 watermark). Written once onboard completes.
      db.exec(`
        CREATE TABLE file_card (
          id              TEXT NOT NULL PRIMARY KEY,
          repo_key        TEXT NOT NULL,
          repo            TEXT NOT NULL,
          path            TEXT NOT NULL,
          content_hash    TEXT NOT NULL,
          loc             INTEGER NOT NULL,
          symbols         TEXT NOT NULL,
          synced_commit   TEXT,
          source          TEXT NOT NULL,
          tldr            TEXT,
          role_primary    TEXT,
          role_tags       TEXT,
          card_status     TEXT NOT NULL DEFAULT 'active'
            CHECK (card_status IN ('active','stale','shadow')),
          model_status    TEXT NOT NULL DEFAULT 'absent'
            CHECK (model_status IN ('active','failed_validation','absent')),
          validated_at    TEXT,
          validation_error TEXT,
          model           TEXT,
          prompt_version  TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          UNIQUE (repo_key, path)
        );
        CREATE INDEX idx_file_card_repo_key ON file_card(repo_key);
        CREATE INDEX idx_file_card_repo_key_status ON file_card(repo_key, card_status);

        CREATE VIRTUAL TABLE file_card_fts USING fts5(
          path, tldr, symbols_fts,
          tokenize = 'porter unicode61'
        );

        CREATE TABLE repo_sync (
          repo_key    TEXT PRIMARY KEY,
          repo        TEXT NOT NULL,
          synced_commit TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Persist the NORMALISED canonical (host/owner/repo or path) that a row's
    // repo_key was derived from. Before this, only the sha256(repo_key) was
    // stored — which can't be reversed — so a repo onboarded via one URL form
    // (ssh) and searched via another (https) produced different keys and
    // SILENTLY returned 0 cards. `repoKey` now normalises via canonicalizeRepo
    // at the single chokepoint, and this column records the canonical so
    // existing rows can be re-keyed (see rekeyRepo / `memory cards rekey`) and
    // future rows carry their identity for debugging. Nullable: pre-007 rows
    // have no stored canonical until they are re-keyed or re-onboarded.
    id: "007-repo-canonical-column",
    up(db) {
      db.exec(`
        ALTER TABLE file_card ADD COLUMN canonical TEXT;
        ALTER TABLE repo_sync ADD COLUMN canonical TEXT;
      `);
    },
  },
  {
    // Memory Feedback Loop — close the loop between WHAT knowledge was served
    // into a ticket's context and HOW that ticket turned out, so memory gets
    // smarter, not just bigger.
    //
    // recall_event — the read-event EDGE the feedback loop learns from. Each
    // row records that a memory item (lore or file card) was SERVED into a
    // given ticket's context during a recall (the runner's cards-for-scope
    // prime). Keyed by (repo, ticket): the served SET per ticket. The
    // (repo, ticket, item_type, item_id) UNIQUE makes re-priming the same
    // ticket idempotent (the served edge is a set, not a stream) — the older,
    // untyped `events(kind='read')` log stays as-is for the audit trail; this
    // table adds the ticket dimension the loop needs.
    //
    // recall_feedback — the idempotency + audit ledger. Exactly one row per
    // (repo, ticket, outcome): applying the same outcome twice is a no-op, so
    // a re-run (or a retried runner call) can never double-adjust. Records how
    // many items were adjusted for the audit trail.
    //
    // flagged_for_review (on lore + file_card) — the surfaced signal. Set when
    // an item was in context for a reworked/blocked ticket: "this knowledge led
    // to rework, a human should look." Cleared on a clean outcome. Additive
    // column, DEFAULT 0, so every existing row reads back as not-flagged.
    //
    // ISOLATION (non-negotiable): none of this reads the dispatch DB. Memory
    // learns from its OWN read-event log + an outcome the runner PASSES in.
    id: "008-recall-feedback",
    up(db) {
      db.exec(`
        CREATE TABLE recall_event (
          id          TEXT PRIMARY KEY,
          repo        TEXT NOT NULL,
          ticket      TEXT NOT NULL,
          item_type   TEXT NOT NULL
            CHECK (item_type IN ('lore','card')),
          item_id     TEXT NOT NULL,
          served_at   TEXT NOT NULL,
          UNIQUE (repo, ticket, item_type, item_id)
        );
        CREATE INDEX idx_recall_event_ticket ON recall_event(repo, ticket);

        CREATE TABLE recall_feedback (
          id             TEXT PRIMARY KEY,
          repo           TEXT NOT NULL,
          ticket         TEXT NOT NULL,
          outcome        TEXT NOT NULL
            CHECK (outcome IN ('clean','reworked','blocked')),
          items_adjusted INTEGER NOT NULL,
          applied_at     TEXT NOT NULL,
          UNIQUE (repo, ticket, outcome)
        );

        ALTER TABLE lore ADD COLUMN flagged_for_review INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE file_card ADD COLUMN flagged_for_review INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
];

/**
 * Apply any pending migrations in order. Idempotent — safe to call on
 * every `openDb()`.
 */
export function runMigrations(db: Database): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);
  const seen = new Set<string>(
    (db.prepare("SELECT id FROM migrations").all() as Array<{ id: string }>).map((r) => r.id),
  );
  // Version ceiling: if the DB carries migrations this binary doesn't ship,
  // it was written by a newer memory. Refuse rather than operate against
  // a schema we don't understand (mixed-version team-shared DB).
  const known = new Set(MIGRATIONS.map((m) => m.id));
  const unknown = [...seen].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new DatabaseTooNewError(unknown);
  }
  const applied: string[] = [];
  const insert = db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (seen.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(m.id, new Date().toISOString());
    })();
    applied.push(m.id);
  }
  return { applied };
}
