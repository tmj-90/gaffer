# Dispatch product specification

## Verdict

Dispatch should be an agent-ready backlog control plane, not a Jira clone.

The product exists to convert rough human/product intent into executable, claimable, evidenced work packets for coding agents.

## One-line pitch

Dispatch is a local or shared backlog control plane where humans define and approve executable work, while agents safely claim tickets, satisfy acceptance criteria, record evidence and escalate decisions.

## User promises

Dispatch should let users say:

- agents do not pick random work
- PMs can add rough work without making it immediately executable
- only ready work is claimable, unless a looser policy allows it
- acceptance criteria are tracked explicitly
- decisions can block or inform work
- agents claim work with leases, not vague assignment
- stale work can recover automatically
- the system can prove what happened through an event log

## Personas

### Solo developer

Wants Claude or another coding agent to work through local tasks without a heavy process.

Needs:

- quick ticket creation
- optional AC
- SQLite
- local CLI/MCP
- light policies
- basic branch safety

### Engineer or tech lead

Wants multiple agents to work on a repo or repo set without trampling each other.

Needs:

- claim leases
- repo scope
- AC evidence
- risk and capability routing
- blockers
- review queue
- event history

### Product manager

Wants to add work and track current status without needing to use agent tooling directly.

Needs:

- simple ticket creation
- draft/refinement state
- backlog view
- blocked decision view
- review status
- evidence links

### Platform owner

Wants safe shared mode.

Needs:

- Postgres
- server-side secrets
- auth scopes
- audit log
- policy packs
- admin visibility

## Product principles

### 1. Draft is not ready

A rough ticket is allowed. A rough ticket should not automatically become executable.

```text
PM idea → draft ticket → refinement → ready ticket → agent claim
```

### 2. Policy packs are optional

Do not force corporate process. Provide named policies that teams can choose.

Examples:

- `solo_loose`
- `team_light`
- `factory_strict`
- `regulated`

### 3. Agents operate through claims

An agent does not own a ticket forever. It holds a lease with a token.

If the agent dies, the lease expires and the work can be reclaimed.

### 4. Evidence beats assertion

Bad:

```text
Agent says AC is done.
```

Good:

```text
AC 3 satisfied by commit abc123, test output, changed files and PR URL.
```

### 5. Decisions are first-class

A ticket can be blocked by a decision. A decision can block many tickets.

Decisions have severity:

- `log_only`
- `agent_can_choose`
- `human_preferred`
- `human_required`
- `security_required`

### 6. Memory remains authoritative knowledge

Dispatch can reference Memory and trigger suggestions, but cannot auto-approve durable knowledge.

## Scope

### In scope for v1

- tickets
- linked repositories
- acceptance criteria
- decisions
- ticket-decision relationships
- claim leases
- AC evidence
- event log
- optional policy packs
- local SQLite
- Postgres-compatible schema
- MCP server
- CLI for humans
- basic web/API plan

### Out of scope for v1

- full project-management board
- sprints and burndown charts
- multi-tenant SaaS
- full Jira/Linear sync
- automatic deployment
- direct production changes
- rich reporting
- custom workflow designer

## Success criteria

Dispatch is successful when:

1. an agent can claim the next ready ticket safely
2. a second agent cannot claim the same ticket at the same time
3. a stale claim can be recovered
4. AC evidence is recorded per criterion
5. blocked tickets are not claimed
6. rough tickets can exist without being executable
7. a human can see why a ticket is in its current state
8. Memory can be consulted without mixing lore and work state

## MVP user journey

### Human creates work

```text
dispatch ticket create \
  --title "Add password reset" \
  --repo auth-service \
  --repo web-app
```

### Human or agent adds AC

```text
dispatch ac add TICKET-123 "Reset tokens expire after 30 minutes"
dispatch ac add TICKET-123 "No user enumeration"
dispatch ac add TICKET-123 "Integration test covers successful reset"
```

### Human marks ready

```text
dispatch ticket ready TICKET-123
```

### Agent claims next work

```text
claim_next_ticket(agent_id="claude-auth-01")
```

### Agent records evidence

```text
record_ac_evidence(
  ticket="TICKET-123",
  ac="AC-2",
  evidence_type="test_output",
  evidence="pytest tests/integration/test_password_reset.py passed"
)
```

### Agent submits review

```text
submit_ticket_for_review(ticket="TICKET-123", pr_url="https://github.com/org/auth-service/pull/44")
```

## Product anti-goals

Do not become:

- another Jira skin
- a generic task list
- a hidden autonomous coding bot
- a prompt-only convention system
- a DB where agents can mutate arbitrary rows

## Naming notes

Dispatch works well because it pairs cleanly with Memory.

```text
Memory: what agents must know
Dispatch: what agents should do next
Crew: how agents operate safely
```
