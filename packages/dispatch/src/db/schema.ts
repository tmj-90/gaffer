/**
 * Dispatch SQLite schema (adapted from docs/05-database-schema.sql).
 *
 * Differences from the Postgres reference: booleans are stored as INTEGER (0/1),
 * timestamps as TEXT (ISO-8601, UTC), IDs as TEXT. CHECK constraints and the
 * partial unique index (one active claim per ticket) are preserved — SQLite
 * supports both. Enum validation is also enforced in the application layer.
 */
export const SCHEMA_VERSION = 14;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  number        INTEGER UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN (
    'draft','refining','ready','claimed','in_progress',
    'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused'
  )),
  priority      INTEGER NOT NULL DEFAULT 0,
  risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
  policy_pack   TEXT NOT NULL DEFAULT 'solo_loose',
  source        TEXT,
  created_by    TEXT,
  reviewer      TEXT,
  branch_name   TEXT,
  pr_url        TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  row_version   INTEGER NOT NULL DEFAULT 0,
  scheduled_after TEXT,
  due_at        TEXT,
  -- EP-001 greenfield marker (schema_version 5). 0/1; 1 ⇒ a bootstrap ticket
  -- the runner delivers in create-a-repo mode with a scoped install allowance.
  -- For an existing DB this column is added by an idempotent ALTER in
  -- connection.ts; the default below mirrors the migration backfill (0).
  bootstrap     INTEGER NOT NULL DEFAULT 0,
  -- WG-049 (schema_version 8): the latest review-rejection feedback, as a JSON
  -- object {reason, reviewer, at}, so a re-claiming agent (and the board) can see
  -- WHY the reviewer sent the ticket back. Set on review reject, cleared when the
  -- ticket re-enters in_review so stale feedback never shows as current. NULL =>
  -- no outstanding rejection. Added by an idempotent ALTER in connection.ts for an
  -- existing DB; the default below (NULL) mirrors the migration backfill.
  last_review_feedback TEXT,
  -- BBT-001 (schema_version 9): the independent black-box testing lane.
  -- can_be_tested (0/1; 1 => eligible for the testing lane) gates entry to
  -- in_testing; test_contract is a JSON {changed_surfaces[], runtime_deps[],
  -- env_vars[], run_command, harness_ready} handover the tester reads to stand the
  -- system up — never the diff. Both are added by an idempotent ALTER in
  -- connection.ts for an existing DB; the defaults below (0 / NULL) mirror the
  -- migration backfill — pre-v9 tickets are not testable and carry no contract.
  can_be_tested INTEGER NOT NULL DEFAULT 0,
  test_contract TEXT,
  -- TRACK-2b (schema_version 14): the HUMAN-CLAIM marker. NULL ⇒ agent-shaped work
  -- (claimable by the factory as normal). NON-NULL ⇒ a human took this ticket "by
  -- hand" (the actor id/name); it moves to in_progress OWNED BY THE HUMAN and the
  -- agent selection loop MUST skip it (the candidate queries filter human_owner IS
  -- NULL). Cleared automatically when the ticket leaves in_progress (hand-back to
  -- ready, submit to review, block, cancel …). Added by an idempotent ALTER in
  -- connection.ts for an existing DB; the default below (NULL) mirrors the backfill —
  -- pre-v14 tickets are all agent-shaped.
  human_owner   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority DESC, created_at ASC);
-- TRACK-2b: partial index over human-owned in-flight work — the board's "by hand"
-- lane and the agent-skip guard both filter on human_owner, so index the non-null set.
CREATE INDEX IF NOT EXISTS idx_tickets_human_owner ON tickets(human_owner) WHERE human_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_risk ON tickets(risk_level);
CREATE INDEX IF NOT EXISTS idx_tickets_policy_pack ON tickets(policy_pack);

CREATE TABLE IF NOT EXISTS repositories (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  local_path      TEXT,
  remote_url      TEXT,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  stack           TEXT,
  risk_level      TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
  test_command    TEXT,
  lint_command    TEXT,
  coverage_command TEXT,
  -- WG-006 (schema_version 6): a hidden repo stays registered but is excluded by
  -- default from the dashboard surfaces (repo list, Factory Map unmapped repos,
  -- repo pickers). 0/1; 1 ⇒ hidden. Reversible via the "Hidden repos" page / CLI.
  -- For an existing DB this column is added by an idempotent ALTER in connection.ts;
  -- the default below mirrors the migration backfill (0 ⇒ visible).
  hidden          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ticket_repos: per-ticket execution repos. The original role/branch_name/pr_url/
-- status columns are kept for back-compat (the runner reads them); WG-002 adds the
-- explicit access boundary columns (access/relation/source/confidence/reasons_json).
-- For an existing DB these columns are added by an idempotent ALTER in connection.ts;
-- the defaults below mirror the migration backfill so fresh + migrated DBs match.
CREATE TABLE IF NOT EXISTS ticket_repos (
  ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN (
    'primary','secondary','affected','read_only_context','test_only'
  )),
  branch_name TEXT,
  pr_url      TEXT,
  status      TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started','branch_created','in_progress','pr_opened','merged','skipped','failed'
  )),
  access      TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('write','read','test','none')),
  relation    TEXT NOT NULL DEFAULT 'confirmed' CHECK (relation IN (
    'confirmed','suggested','rejected','context_only','implicit_single_repo'
  )),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN (
    'manual','scope_inferred','agent_suggested','memory','codeowners','mono_fallback'
  )),
  confidence  REAL,
  reasons_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_repos_access ON ticket_repos(ticket_id, access);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  text               TEXT NOT NULL,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','satisfied','failed','waived')),
  verification_method TEXT,
  evidence_required  INTEGER NOT NULL DEFAULT 0,
  verified_by        TEXT,
  verified_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ac_ticket ON acceptance_criteria(ticket_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_ac_status ON acceptance_criteria(status);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  question      TEXT NOT NULL,
  rationale     TEXT,
  status        TEXT NOT NULL CHECK (status IN (
    'requested','agent_proposed','human_required','accepted','rejected','superseded'
  )),
  decision_type TEXT NOT NULL DEFAULT 'product' CHECK (decision_type IN (
    'human_blocker','agent_local','architectural','product','security','technical'
  )),
  severity      TEXT NOT NULL DEFAULT 'human_preferred' CHECK (severity IN (
    'log_only','agent_can_choose','human_preferred','human_required','security_required'
  )),
  proposed_answer TEXT,
  proposed_by   TEXT,
  confidence    TEXT CHECK (confidence IN ('low','medium','high')),
  resolved_answer TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT,
  memory_record_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_severity ON decisions(severity);

CREATE TABLE IF NOT EXISTS ticket_decisions (
  ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN ('blocks','informs','created_by','supersedes')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, decision_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_ticket_decisions_decision ON ticket_decisions(decision_id);

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  agent_type   TEXT NOT NULL DEFAULT 'coding_agent',
  model        TEXT,
  runtime      TEXT,
  host         TEXT,
  max_risk     TEXT NOT NULL DEFAULT 'medium' CHECK (max_risk IN ('low','medium','high','critical')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  created_by   TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS ticket_required_capabilities (
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (ticket_id, capability)
);

CREATE TABLE IF NOT EXISTS ticket_claims (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  claim_token_hash TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','revoked','completed')),
  expires_at      TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_claim_per_ticket
  ON ticket_claims(ticket_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_claims_agent_status ON ticket_claims(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_expiry ON ticket_claims(status, expires_at);

CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  ac_id        TEXT REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  repo_id      TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  decision_id  TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'test_output','coverage_report','commit','branch','pull_request','diff_summary',
    'screenshot','log','manual_note','ci_run','static_analysis','lore_record'
  )),
  summary      TEXT NOT NULL,
  uri          TEXT,
  payload_json TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_ticket ON evidence(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_ac ON evidence(ac_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence(evidence_type);

CREATE TABLE IF NOT EXISTS work_events (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('human','agent','admin','system')),
  actor_id     TEXT,
  event_type   TEXT NOT NULL,
  payload_json TEXT,
  correlation_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON work_events(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON work_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON work_events(correlation_id);

CREATE TABLE IF NOT EXISTS external_refs (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  provider    TEXT NOT NULL,
  external_id TEXT,
  url         TEXT,
  relation    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_external_refs_entity ON external_refs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_external_refs_provider ON external_refs(provider, external_id);

-- ============================================================================
-- Factory Map scope graph (FG-001 + FG-002). Additive, schema_version 2.
--
-- scope_nodes are first-class product/system areas; scope_edges form the graph
-- between them; scope_repos is the many-to-many mapping of repos into scope
-- nodes, each with a relation + default access. Repos with NO scope_repos row
-- are "unmapped" and behave as implicit single-repo scopes (mono fallback).
-- ============================================================================

CREATE TABLE IF NOT EXISTS scope_nodes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN (
    'factory','domain','product','capability','system','service','library','external_dependency','epic'
  )),
  description   TEXT,
  risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
  owner         TEXT,
  tags_json     TEXT,
  lore_tags_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scope_nodes_type ON scope_nodes(type);
CREATE INDEX IF NOT EXISTS idx_scope_nodes_name ON scope_nodes(name);

CREATE TABLE IF NOT EXISTS scope_edges (
  id           TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN (
    'contains','depends_on','calls','publishes_to','consumes_from','shares_library','deployed_with'
  )),
  confidence   REAL,
  reasons_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (from_node_id, to_node_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_scope_edges_from ON scope_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_scope_edges_to ON scope_edges(to_node_id);

CREATE TABLE IF NOT EXISTS scope_repos (
  id             TEXT PRIMARY KEY,
  scope_node_id  TEXT NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL CHECK (relation IN (
    'owns','contains','uses','depends_on','shared_by','deployed_with','read_context','write_target','test_target'
  )),
  default_access TEXT NOT NULL DEFAULT 'read' CHECK (default_access IN ('write','read','test','none')),
  confidence     REAL,
  role_description TEXT,
  reasons_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope_node_id, repo_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_scope_repos_node ON scope_repos(scope_node_id);
CREATE INDEX IF NOT EXISTS idx_scope_repos_repo ON scope_repos(repo_id);

-- ============================================================================
-- Ticket scope links (WG-001). Stores product/system scope SEPARATELY from the
-- concrete execution repos (ticket_repos). A ticket may link to many scope
-- nodes; at most ONE 'primary' per ticket (enforced in the service layer).
-- 'suggested' carries confidence + reasons; 'rejected' rows are retained for
-- audit; 'implicit_repo' is auto-recorded when a ticket targets an unmapped repo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ticket_scope_nodes (
  ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  scope_node_id TEXT NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  relation      TEXT NOT NULL DEFAULT 'secondary' CHECK (relation IN (
    'primary','secondary','suggested','rejected','implicit_repo'
  )),
  confidence    REAL,
  reasons_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, scope_node_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_scope_nodes_node ON ticket_scope_nodes(scope_node_id);
CREATE INDEX IF NOT EXISTS idx_ticket_scope_nodes_relation ON ticket_scope_nodes(ticket_id, relation);

-- ============================================================================
-- Per-repo delivery artifacts (WG-005). Additive, schema_version 4.
--
-- One row per (ticket, repo) capturing WHERE that repo's slice of the work was
-- delivered: the branch, commit, PR and a delivery status. The single-repo
-- fallback yields one row; a multi-repo ticket yields one row per write repo.
-- The ticket's top-level branch_name/pr_url (tickets table) is retained as a
-- summary / back-compat pointer and is NOT replaced by this table. The repo
-- must be linked to the ticket via ticket_repos (enforced in the facade), and
-- both FKs CASCADE so deliveries vanish with their ticket or repo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ticket_repo_delivery (
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch_name  TEXT,
  commit_sha   TEXT,
  pr_url       TEXT,
  status       TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started','branch_created','changes_made','tests_failed',
    'tests_passed','pr_opened','review_ready','done'
  )),
  evidence_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_repo_delivery_repo ON ticket_repo_delivery(repo_id);
CREATE INDEX IF NOT EXISTS idx_ticket_repo_delivery_status ON ticket_repo_delivery(ticket_id, status);

-- ============================================================================
-- Ticket dependencies (EP-001). Additive, schema_version 5.
--
-- A directed "must finish first" edge between two tickets: the ticket at
-- ticket_id cannot be claimed until the ticket at depends_on_ticket_id is
-- 'done'. The (ticket_id, depends_on_ticket_id) pair is the primary key so a
-- dependency is declared at most once; a self-dependency is rejected in the
-- service layer (and would be pointless). Both FKs CASCADE so a deleted ticket
-- takes its dependency edges (in either direction) with it. Cycle prevention is
-- enforced in the repository/core layer (SQLite can't express it as a CHECK).
-- This is a brand-new table created idempotently by CREATE TABLE IF NOT EXISTS,
-- so (like ticket_repo_delivery) no ADD COLUMN migration is needed for it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ticket_dependencies (
  ticket_id            TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  depends_on_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, depends_on_ticket_id),
  CHECK (ticket_id <> depends_on_ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_dependencies_depends_on
  ON ticket_dependencies(depends_on_ticket_id);

-- ============================================================================
-- Run-activity registry (RUN-ACTIVITY). Additive, schema_version 10.
--
-- A control plane for the detached children the API spawns (the "Suggest work"
-- / onboard / poll-work / merge buttons). Before this, those runs were spawned
-- with stdio ignore and never tracked, so a run that filed nothing left no
-- trace. One row per spawned run: recorded running on spawn, flipped to
-- succeeded/failed when the child exits, or swept to unknown on API startup
-- if its pid is no longer alive (the API restarted mid-run). log_path points
-- at the per-run capture file (GAFFER_DATA/runs/<id>.log) so a 0-ticket or
-- errored run is diagnosable. Standalone (no FKs to tickets/repos — a run may
-- target a repo by name that isn't registered, and must outlive ticket churn),
-- so it is created idempotently by CREATE TABLE IF NOT EXISTS with no ALTER.
-- ============================================================================

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (
    'product_owner','onboard','poll_work','merge','other'
  )),
  repo       TEXT,
  pid        INTEGER,
  status     TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at   TEXT,
  exit_code  INTEGER,
  log_path   TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status_started ON runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- ============================================================================
-- Plan sessions (H9 — durable async plan-build chat). Additive, schema_version 11.
--
-- Each row is one "Plan a build" conversation. The messages array (JSON) stores
-- role+content+ts turns so the panel can restore exactly where it left off on
-- reload or navigation-away. plan_json is populated once the decompose helper
-- returns a plan phase. When the user starts fresh the current session is
-- archived (status → 'abandoned') and a new row is inserted.
--
-- Standalone (no FKs to tickets/repos — a session outlives its epic) so it is
-- created idempotently by CREATE TABLE IF NOT EXISTS with no ALTER needed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS plan_sessions (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','confirmed','abandoned')),
  brief         TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  plan_json     TEXT,
  target_repo   TEXT,
  target_scope  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_sessions_status_created
  ON plan_sessions(status, created_at DESC);

-- ============================================================================
-- Paused deliveries (PAUSE-ON-CAP). Additive, schema_version 12.
--
-- One row per ticket whose IN-FLIGHT delivery hit the turn cap (GAFFER_MAX_TURNS)
-- or the budget cap (GAFFER_BUDGET_REMAINING) and was PAUSED IN PLACE rather than
-- torn down. The row is the durable RESUME CONTEXT: it survives a runner restart so
-- the factory loop can re-enter delivery in the EXISTING worktree (no re-clone, no
-- lost work). resume_requested (0/1) is flipped to 1 by the human Continue action;
-- the loop's selection picks up resume-requested rows and re-invokes the agent on
-- branch_name in worktree_path. The row is deleted on resume-completion or Stop.
--
-- Keyed 1:1 on ticket_id (FK CASCADE so it vanishes with its ticket). A brand-new
-- standalone table created idempotently by CREATE TABLE IF NOT EXISTS — no ADD
-- COLUMN migration needed (only the tickets.status CHECK widening, in connection.ts).
-- ============================================================================

CREATE TABLE IF NOT EXISTS paused_deliveries (
  ticket_id        TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL CHECK (reason IN ('cap_hit','budget_cap')),
  branch_name      TEXT,
  worktree_path    TEXT,
  worktrees_json   TEXT,
  repo             TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  turns            INTEGER,
  spend            TEXT,
  resume_requested INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_paused_deliveries_resume
  ON paused_deliveries(resume_requested, created_at ASC);

-- ============================================================================
-- Failure-diagnosis trail (FAILURE-DIAGNOSIS). Additive, schema_version 13.
--
-- One row per rework ATTEMPT the runner records between failed delivery retries.
-- Where tickets.last_review_feedback keeps only the LATEST attempt (overwritten
-- each retry, for the board chip), this table APPENDS every attempt so the full
-- ordered failure history survives — the surface an operator returns to when
-- triaging an async engine. Each row carries the DISTILLED failure the runner's
-- DoD distiller produced (the real failing test + assertion/stack, NOT a
-- gate-name summary), the gate that failed, the attempt counter, and the AC it
-- was working toward when known. Powers the per-ticket "why did #N fail" view and
-- the cross-ticket "these keep bouncing" signal (repeated same-gate failures).
--
-- Keyed by ticket_id (FK CASCADE so the trail vanishes with its ticket). A
-- brand-new standalone table created idempotently by CREATE TABLE IF NOT EXISTS —
-- no ADD COLUMN migration needed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rework_attempts (
  id                TEXT PRIMARY KEY,
  ticket_id         TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL,
  max_attempts      INTEGER,
  gate              TEXT,
  distilled_failure TEXT NOT NULL,
  ac_id             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rework_attempts_ticket
  ON rework_attempts(ticket_id, attempt ASC);
CREATE INDEX IF NOT EXISTS idx_rework_attempts_gate
  ON rework_attempts(gate);
`;
