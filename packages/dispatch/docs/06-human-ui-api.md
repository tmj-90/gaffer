# Dispatch human UI and API plan

## Verdict

The human interface should be a thin control surface over the agent-ready backlog. It should not become Jira.

## Human UI goals

The UI should help humans answer:

- what work exists?
- what is executable?
- what is blocked?
- what is being worked now?
- what needs my decision?
- what needs review?
- what evidence did the agent produce?

## Views

### Backlog

Columns:

- number
- title
- status
- priority
- risk
- repos
- AC count
- blockers
- assignee/claim
- updated

Filters:

- status
- repo
- risk
- blocker status
- capability
- source

### Draft intake

For PMs and non-technical users.

Fields:

- title
- description
- target repo or product area
- user value
- constraints
- links or screenshots

Draft tickets created here should not be claimable unless the selected policy allows it.

### Refinement queue

Shows tickets missing readiness data.

Examples:

- no repo
- no AC
- unresolved decision
- missing risk level
- vague description

### Ready queue

Shows tickets claimable by agents.

Useful fields:

- priority
- required capabilities
- risk
- estimated repo scope
- blockers clear

### Active factory

Shows active claims.

Fields:

- ticket
- agent
- lease expiry
- heartbeat
- branch
- current state
- latest event

Actions:

- revoke claim
- extend lease
- inspect evidence
- requeue

### Decisions

Grouped by:

- human_required
- security_required
- agent_proposed
- accepted
- rejected

Decision resolution form:

- answer
- rationale
- applies to tickets
- promote to Memory suggestion?

### Review queue

Shows tickets in review.

Each review item should show:

- summary
- linked PRs
- AC status
- evidence per AC
- decisions made
- Memory suggestions
- changed repos

Actions:

- approve done
- reject to ready
- reject to refining
- request decision
- request more evidence

### Audit/event view

Shows timeline:

```text
09:00 ticket created
09:02 AC added
09:05 marked ready
09:06 claimed by claude-auth-01
09:07 branch recorded
09:14 AC 1 satisfied
09:20 PR opened
09:21 submitted for review
```

This is critical for trust.

## API shape

The UI can call HTTP endpoints over the same Dispatch core.

Suggested REST endpoints:

```text
GET    /tickets
POST   /tickets
GET    /tickets/{id}
POST   /tickets/{id}/acceptance-criteria
POST   /tickets/{id}/ready
POST   /tickets/{id}/review/approve
POST   /tickets/{id}/review/reject
GET    /tickets/{id}/events
GET    /decisions
POST   /decisions
POST   /decisions/{id}/resolve
GET    /claims
POST   /claims/{id}/revoke
GET    /agents
GET    /repositories
```

## Roles

### PM

Can:

- create draft tickets
- view status
- comment
- request decisions

Cannot by default:

- mark high-risk ticket ready
- approve done
- resolve security decisions

### Engineer

Can:

- refine tickets
- add AC
- mark ready under policy
- resolve technical/product decisions if allowed
- review work

### Tech lead

Can:

- override policy
- resolve architectural decisions
- approve high-risk readiness
- revoke claims

### Admin

Can:

- manage agents
- manage policies
- manage repo registry
- inspect audit trail

## UI anti-goals

Do not build early:

- sprint planning
- velocity charts
- burndowns
- complex roadmap hierarchy
- custom fields framework
- rich workflow builder

## First UI version

Build only:

1. backlog list
2. ticket detail page
3. create ticket form
4. add AC form
5. mark ready button
6. blocked decisions view
7. active claims view
8. review queue
9. event timeline

This is enough for a high-quality local/shared demo.
