# Dispatch domain model

## Core concepts

Dispatch has six central concepts:

1. ticket
2. acceptance criterion
3. decision
4. claim
5. evidence
6. event

A minimal implementation should still include all six. Skipping events or claims will make the system unreliable.

## Ticket

A ticket is an executable unit of work or a draft that may become executable.

### Required fields

```text
id
number
title
description
status
priority
created_at
updated_at
```

### Recommended fields

```text
risk_level
source
created_by
reviewer
policy_pack
branch_name
pr_url
attempt_count
row_version
```

### Statuses

```text
draft
refining
ready
claimed
in_progress
blocked
in_review
done
failed
cancelled
```

### Ticket metadata

A ticket can include:

- tags
- capability requirements
- risk reasons
- expected verification level
- due date
- scheduled after date
- parent ticket ID
- external references

## Ticket repository links

Do not store repositories as a comma-separated text field.

Use a join table:

```text
ticket_repos(ticket_id, repo_id, role)
```

Repo roles:

```text
primary
secondary
affected
read_only_context
test_only
```

This allows a ticket to span multiple repos without losing granularity.

## Acceptance criterion

An acceptance criterion is a separately trackable requirement linked to one ticket.

### Fields

```text
id
ticket_id
text
status
sort_order
verification_method
evidence_required
created_at
updated_at
```

### AC statuses

```text
pending
satisfied
failed
waived
```

### Verification methods

Suggested values:

```text
unit_test
integration_test
e2e_test
static_analysis
manual_review
screenshot
log_output
code_inspection
not_applicable
```

### Evidence requirement

Policy packs can decide whether evidence is required.

- loose mode: evidence optional
- team mode: evidence recommended
- strict mode: evidence required
- regulated mode: evidence required and immutable

## Evidence

Evidence proves something about work performed.

Evidence should attach to one of:

- acceptance criterion
- ticket
- decision
- repo status
- review

### Evidence types

```text
test_output
coverage_report
commit
branch
pull_request
diff_summary
screenshot
log
manual_note
ci_run
static_analysis
lore_record
```

### Evidence shape

```json
{
  "id": "ev_123",
  "ticket_id": "ticket_123",
  "ac_id": "ac_456",
  "type": "test_output",
  "summary": "Password reset integration test passed",
  "uri": null,
  "payload": {
    "command": "pytest tests/integration/test_password_reset.py",
    "exit_code": 0
  },
  "created_by": "agent:claude-auth-01",
  "created_at": "2026-06-20T12:00:00Z"
}
```

Evidence should be append-only once recorded. Corrections should create new evidence or a superseding event.

## Decision

A decision captures uncertainty, a chosen answer or a blocker.

### Fields

```text
id
title
question
status
decision_type
severity
proposed_answer
resolved_answer
proposed_by
resolved_by
resolved_at
memory_record_id
created_at
updated_at
```

### Decision statuses

```text
requested
agent_proposed
human_required
accepted
rejected
superseded
```

### Decision severities

```text
log_only
agent_can_choose
human_preferred
human_required
security_required
```

### Decision relationships

A decision can relate to many tickets.

Relationship types:

```text
blocks
informs
created_by
supersedes
```

A ticket is claim-blocked if it has a related decision where:

```text
relation = blocks
and decision status is not accepted/rejected/superseded
```

## Claim

A claim is a lease that lets one agent work on a ticket.

### Fields

```text
id
ticket_id
agent_id
claim_token
status
expires_at
heartbeat_at
created_at
released_at
```

### Claim statuses

```text
active
released
expired
revoked
completed
```

### Rules

Only an actor holding the active claim token can:

- move `claimed` to `in_progress`
- record implementation evidence
- mark AC as satisfied
- submit ticket for review
- mark ticket blocked from implementation

Admins can revoke claims, but that should be evented.

## Event

Events are mandatory.

The event log is the source of truth for what happened.

### Fields

```text
id
entity_type
entity_id
actor_type
actor_id
event_type
payload_json
created_at
correlation_id
```

### Common event types

```text
ticket_created
ticket_refined
ticket_marked_ready
ticket_claimed
claim_heartbeat
claim_expired
ticket_started
ac_added
ac_satisfied
ac_failed
ac_waived
decision_requested
decision_resolved
ticket_blocked
ticket_submitted_for_review
ticket_rejected
ticket_done
branch_recorded
pr_recorded
lore_consulted
lore_suggestion_created
idle_loop_created_ticket
policy_check_failed
```

## Policy pack

A policy pack is a named set of transition checks.

Policy packs should be evaluated by Dispatch core, not by prompts.

Example:

```json
{
  "id": "team_light",
  "ready_requires": ["title", "description", "repo", "at_least_one_ac"],
  "done_requires": ["all_ac_resolved", "pr_url"],
  "claim_blocks": ["blocking_decisions", "risk_exceeds_agent"]
}
```

## Capability requirement

Tickets may require capabilities.

Examples:

```text
backend
frontend
tests
auth
payments
infra
database_migration
security_review
multi_repo
```

Agents declare capabilities through Crew. Dispatch should accept the claims only if capability policy passes.

## Risk level

Suggested levels:

```text
low
medium
high
critical
```

Risk reasons:

```text
touches_auth
touches_payments
touches_migration
touches_production_config
touches_ci
touches_infra
touches_public_api
deletes_code
multi_repo_change
```

Risk should influence policy, but it should not always block work. A solo user may allow high-risk local plans. A team may require human approval.

## Entity relationship overview

```text
ticket 1..n acceptance_criteria
ticket n..m repositories
ticket n..m decisions
ticket 1..n claims
ticket 1..n evidence
ticket 1..n events
decision 0..1 memory_record
```
