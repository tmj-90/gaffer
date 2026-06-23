-- Dispatch database schema, first-cut
-- Target: Postgres first, SQLite-compatible shape where practical
-- Notes:
-- 1. Use UUIDs in Postgres. SQLite can store IDs as text.
-- 2. Use application-level enum validation for SQLite.
-- 3. Event log should be append-only by convention and permissions.

-- =========================
-- Tickets
-- =========================

create table tickets (
  id text primary key,
  number integer unique,
  title text not null,
  description text not null default '',

  status text not null check (status in (
    'draft',
    'refining',
    'ready',
    'claimed',
    'in_progress',
    'blocked',
    'in_review',
    'done',
    'failed',
    'cancelled'
  )),

  priority integer not null default 0,
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high', 'critical')),
  policy_pack text not null default 'solo_loose',

  source text,
  created_by text,
  reviewer text,

  branch_name text,
  pr_url text,

  attempt_count integer not null default 0,
  row_version integer not null default 0,

  scheduled_after timestamptz,
  due_at timestamptz,

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index idx_tickets_status_priority on tickets(status, priority desc, created_at asc);
create index idx_tickets_risk on tickets(risk_level);
create index idx_tickets_policy_pack on tickets(policy_pack);

-- =========================
-- Repositories
-- =========================

create table repositories (
  id text primary key,
  name text not null unique,
  local_path text,
  remote_url text,
  default_branch text not null default 'main',
  stack text,
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high', 'critical')),
  test_command text,
  lint_command text,
  coverage_command text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table ticket_repos (
  ticket_id text not null references tickets(id) on delete cascade,
  repo_id text not null references repositories(id) on delete cascade,
  role text not null default 'primary' check (role in (
    'primary',
    'secondary',
    'affected',
    'read_only_context',
    'test_only'
  )),
  branch_name text,
  pr_url text,
  status text not null default 'not_started' check (status in (
    'not_started',
    'branch_created',
    'in_progress',
    'pr_opened',
    'merged',
    'skipped',
    'failed'
  )),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  primary key (ticket_id, repo_id)
);

-- =========================
-- Acceptance criteria
-- =========================

create table acceptance_criteria (
  id text primary key,
  ticket_id text not null references tickets(id) on delete cascade,
  text text not null,
  sort_order integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'satisfied', 'failed', 'waived')),
  verification_method text,
  evidence_required boolean not null default false,
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index idx_ac_ticket on acceptance_criteria(ticket_id, sort_order);
create index idx_ac_status on acceptance_criteria(status);

-- =========================
-- Decisions
-- =========================

create table decisions (
  id text primary key,
  title text not null,
  question text not null,
  rationale text,

  status text not null check (status in (
    'requested',
    'agent_proposed',
    'human_required',
    'accepted',
    'rejected',
    'superseded'
  )),

  decision_type text not null default 'product' check (decision_type in (
    'human_blocker',
    'agent_local',
    'architectural',
    'product',
    'security',
    'technical'
  )),

  severity text not null default 'human_preferred' check (severity in (
    'log_only',
    'agent_can_choose',
    'human_preferred',
    'human_required',
    'security_required'
  )),

  proposed_answer text,
  proposed_by text,
  confidence text check (confidence in ('low', 'medium', 'high')),

  resolved_answer text,
  resolved_by text,
  resolved_at timestamptz,

  memory_record_id text,

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index idx_decisions_status on decisions(status);
create index idx_decisions_severity on decisions(severity);

create table ticket_decisions (
  ticket_id text not null references tickets(id) on delete cascade,
  decision_id text not null references decisions(id) on delete cascade,
  relation text not null check (relation in ('blocks', 'informs', 'created_by', 'supersedes')),
  created_at timestamptz not null default current_timestamp,
  primary key (ticket_id, decision_id, relation)
);

create index idx_ticket_decisions_decision on ticket_decisions(decision_id);

-- =========================
-- Agents and claims
-- =========================

create table agents (
  id text primary key,
  display_name text,
  agent_type text not null default 'coding_agent',
  model text,
  runtime text,
  host text,
  max_risk text not null default 'medium' check (max_risk in ('low', 'medium', 'high', 'critical')),
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  created_by text,
  last_seen_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table agent_capabilities (
  agent_id text not null references agents(id) on delete cascade,
  capability text not null,
  primary key (agent_id, capability)
);

create table ticket_required_capabilities (
  ticket_id text not null references tickets(id) on delete cascade,
  capability text not null,
  primary key (ticket_id, capability)
);

create table ticket_claims (
  id text primary key,
  ticket_id text not null references tickets(id) on delete cascade,
  agent_id text not null references agents(id) on delete restrict,
  claim_token_hash text not null,
  status text not null default 'active' check (status in ('active', 'released', 'expired', 'revoked', 'completed')),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null default current_timestamp,
  created_at timestamptz not null default current_timestamp,
  released_at timestamptz
);

create unique index idx_one_active_claim_per_ticket
  on ticket_claims(ticket_id)
  where status = 'active';

create index idx_claims_agent_status on ticket_claims(agent_id, status);
create index idx_claims_expiry on ticket_claims(status, expires_at);

-- =========================
-- Evidence
-- =========================

create table evidence (
  id text primary key,
  ticket_id text not null references tickets(id) on delete cascade,
  ac_id text references acceptance_criteria(id) on delete cascade,
  repo_id text references repositories(id) on delete set null,
  decision_id text references decisions(id) on delete set null,

  evidence_type text not null check (evidence_type in (
    'test_output',
    'coverage_report',
    'commit',
    'branch',
    'pull_request',
    'diff_summary',
    'screenshot',
    'log',
    'manual_note',
    'ci_run',
    'static_analysis',
    'lore_record'
  )),

  summary text not null,
  uri text,
  payload_json text,
  created_by text not null,
  created_at timestamptz not null default current_timestamp
);

create index idx_evidence_ticket on evidence(ticket_id, created_at);
create index idx_evidence_ac on evidence(ac_id);
create index idx_evidence_type on evidence(evidence_type);

-- =========================
-- Events
-- =========================

create table work_events (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'admin', 'system')),
  actor_id text,
  event_type text not null,
  payload_json text,
  correlation_id text,
  created_at timestamptz not null default current_timestamp
);

create index idx_events_entity on work_events(entity_type, entity_id, created_at);
create index idx_events_type on work_events(event_type, created_at);
create index idx_events_correlation on work_events(correlation_id);

-- =========================
-- External references
-- =========================

create table external_refs (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  provider text not null,
  external_id text,
  url text,
  relation text,
  created_at timestamptz not null default current_timestamp
);

create index idx_external_refs_entity on external_refs(entity_type, entity_id);
create index idx_external_refs_provider on external_refs(provider, external_id);

-- =========================
-- Postgres claim query pattern
-- =========================

-- This query is illustrative. Application code should bind parameters and create IDs/tokens securely.
-- It assumes a function or application-generated IDs for claim rows.

-- with next_ticket as (
--   select t.id
--   from tickets t
--   where t.status = 'ready'
--     and (t.scheduled_after is null or t.scheduled_after <= now())
--     and not exists (
--       select 1
--       from ticket_decisions td
--       join decisions d on d.id = td.decision_id
--       where td.ticket_id = t.id
--         and td.relation = 'blocks'
--         and d.status not in ('accepted', 'rejected', 'superseded')
--     )
--     and not exists (
--       select 1
--       from ticket_claims c
--       where c.ticket_id = t.id
--         and c.status = 'active'
--         and c.expires_at > now()
--     )
--   order by t.priority desc, t.created_at asc
--   for update skip locked
--   limit 1
-- )
-- update tickets t
-- set status = 'claimed',
--     attempt_count = attempt_count + 1,
--     row_version = row_version + 1,
--     updated_at = now()
-- from next_ticket
-- where t.id = next_ticket.id
-- returning t.*;
