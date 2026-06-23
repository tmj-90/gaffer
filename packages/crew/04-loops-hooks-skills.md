# Crew loops, hooks and skills

## Verdict

Crew's power should come from configurable loops and hooks, but v1 should include only a small set of built-ins.

## Loop types

### Implementation loop

Purpose: execute claimable Dispatch tickets.

Default flow:

```text
claim ticket
build context packet
search Memory
create branch
implement
run checks
record AC evidence
submit for review
suggest lore if needed
```

Inputs:

- agent profile
- Dispatch policy
- repo inventory
- safety policy
- Memory search config

Outputs:

- Dispatch events
- AC evidence
- branch/PR references
- decision blockers
- Memory suggestions

### Idle loops

Purpose: create useful work when no tickets are ready.

Default mode:

```text
observe and create draft tickets
```

#### Self-improving closed loop

By default an idle loop's drafts wait for a human to promote them to `ready`.
The `loops.self_improve` switch (OFF by default) closes that gap: when enabled,
an idle tick may promote its own drafts to `ready` so the delivery loop claims
them — no human in the promote step. It is deliberately bounded:

- **off by default** — `enabled: false`;
- **strict opt-in** — a repo must be named in `self_improve.repos` (empty = none);
- **risk-gated** — only repos at/below `self_improve.max_risk` (default `low`);
- **capped** — at most `self_improve.max_ready_per_run` promotions per tick.

A promotion records a `self_improve_promoted` event; hitting the cap records
`self_improve_cap_reached`. It never edits code — it only flips an
already-drafted improvement finding to claimable.

Recommended idle loops:

1. coverage gap scan
2. test quality scan
3. documentation gap scan
4. lore gap scan
5. design drift scan
6. dead code scan
7. flaky test scan
8. dependency hygiene scan

#### Coverage gap scan

Flow:

```text
run coverage command
parse weak files or modules
inspect whether low coverage matters
create draft Dispatch ticket with evidence
```

Do not auto-implement coverage improvements in v1.

#### Test quality scan

Looks for:

- tests with no assertions
- skipped tests
- brittle snapshots
- over-broad mocks
- missing integration tests for risky areas

Output:

- draft Dispatch ticket
- evidence summary

#### Documentation gap scan

Looks for:

- public APIs without docs
- setup steps missing
- stale README commands
- missing runbooks

Output:

- draft ticket
- optional Memory suggestion if durable convention is missing

#### Lore gap scan

Looks for repeated patterns not captured in Memory.

Output:

- Memory suggestion
- optional Dispatch ticket to review/ratify it

#### Design drift scan

Compares code structure to Memory boundaries.

Output:

- decision request
- draft ticket
- Memory challenge

## Review loops

Optional later.

Examples:

- PR review loop
- AC evidence validation loop
- security review loop
- design review loop

These should not approve their own work.

## Hook points

### before_claim

Use cases:

- filter tickets by business hours
- prevent high-risk tickets on weak agents
- enforce repo availability

### after_claim

Use cases:

- create branch
- load context packet
- record agent environment

### before_context_packet

Use cases:

- add custom repo metadata
- enrich ticket with product links

### after_context_packet

Use cases:

- redact extra fields
- add team-specific notes

### before_implementation

Use cases:

- require clean working tree
- check branch prefix
- run baseline tests

### after_tests

Use cases:

- parse test output
- attach evidence
- update AC status

### before_submit_review

Use cases:

- require diff summary
- require PR URL
- require all evidence

### after_ticket_done

Use cases:

- create Memory suggestion
- archive branch
- sync external issue

### on_blocked

Use cases:

- create decision request
- notify human
- add ticket to blocked queue

### on_idle

Use cases:

- run coverage scan
- run documentation scan
- inspect flaky tests

### on_failure

Use cases:

- classify failure
- requeue ticket
- create blocker
- mark agent unhealthy

## Hook contract

Input:

```json
{
  "hook_name": "after_tests",
  "factory": {},
  "agent": {},
  "ticket": {},
  "repo": {},
  "context_packet": {},
  "event": {}
}
```

Output:

```json
{
  "status": "success",
  "events": [],
  "evidence": [],
  "warnings": [],
  "policy_overrides_requested": []
}
```

Hooks cannot bypass safety policy. They can request approval or emit events.

## Skills

Skills are versioned executable procedures.

### Skill shape

```yaml
id: add-fastapi-endpoint
version: 1
name: Add FastAPI endpoint
applies_to:
  stacks: [python, fastapi]
  capabilities: [backend]
steps:
  - inspect existing route patterns
  - add request and response schemas
  - add route handler
  - add unit tests
  - update OpenAPI docs if needed
  - run pytest
evidence:
  - changed_files
  - test_output
  - diff_summary
```

### Skill sources

- built-in templates
- repo scan output
- human-authored files
- generated suggestions requiring approval

### Skill storage

Store skills in Crew config or a `skills/` directory.

Do not put skills in Memory unless they are high-level durable conventions. Detailed procedures belong in Crew.

## Built-in skills for v1

Minimum:

- run-tests
- run-lint
- run-coverage
- create-branch
- record-evidence
- submit-review
- create-draft-ticket-from-finding

Later:

- add-unit-test
- add-integration-test
- update-docs
- add-api-endpoint
- add-db-migration
- refactor-module

## Loop scheduling

Keep simple in v1.

Supported triggers:

```text
manual
when_queue_empty
after_ticket_done
on_schedule optional later
```

Avoid complex background scheduling before the vertical slice works.

## Loop safety defaults

```yaml
idle_loop_mode: create_draft_tickets
implementation_loop_requires_claim: true
review_loop_can_approve_own_work: false
lore_suggestions_auto_approve: false
```
