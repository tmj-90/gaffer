# Crew product specification

## Verdict

Crew should be the local-first software factory runtime.

It should not store the backlog and it should not store durable knowledge. It should orchestrate agents, repos, policies, hooks, skills and loops using Dispatch and Memory as supporting systems.

## One-line pitch

Crew runs a safe local or shared software factory: it routes agents to Dispatch tickets, supplies Memory context, applies repo protections, runs implementation and quality loops and creates controlled idle work when the backlog is empty.

## Core job

Crew answers:

```text
How should agents operate safely and usefully across this repo set?
```

It handles:

- factory setup
- repo inventory
- agent registry
- safety policy
- implementation loops
- idle loops
- hooks
- skills
- context-packet assembly
- Dispatch integration
- Memory integration

## Product principles

### 1. Local-first

Default mode should be local, offline and stdio-based.

No network listener by default. No remote DB by default. No shared secrets passed through the model.

### 2. Safe-by-default

The default should prevent destructive repo operations.

Examples:

- no force pushes
- no push to protected branches
- no branch deletion
- no writes to secrets
- no writes to `.git`
- no arbitrary filesystem access outside configured repo roots

### 3. Observe and propose before mutate

Idle loops should default to creating draft Dispatch tickets, not surprise PRs.

### 4. Hooks are escape hatches

Teams should be able to customise workflows without forking the runtime.

### 5. Skills are executable procedures, not lore

Memory says what is true and why. Skills say how to perform repeatable work.

### 6. Crew should be boring where possible

It should coordinate systems and enforce policies, not invent a complex autonomous platform in v1.

## Personas

### Solo developer

Wants a local agent factory with sensible safety defaults.

Needs:

- simple config
- repo detection
- local Dispatch SQLite
- local Memory access
- one implementation loop
- one idle loop
- command guards

### Engineering team

Wants multiple agents to work without breaking branches or duplicating effort.

Needs:

- agent identity
- capability routing
- shared Dispatch
- repo policies
- safety logs
- review workflow

### Tech lead/platform owner

Wants to define how the factory behaves.

Needs:

- policy files
- hooks
- skill registry
- repo registry
- agent registry
- failure reporting
- safety approvals

## Operating modes

### Local loose

- local SQLite Dispatch
- local Memory
- single user
- one or two agents
- light process
- strict Git safety defaults

### Local strict

- local DB
- required branch prefix
- AC evidence required
- restricted filesystem
- idle loops only create draft tickets

### Shared team

- shared Postgres Dispatch
- remote or local MCP
- registered agents
- role-based scopes
- central repo inventory
- audit trail

## Main capabilities

### Factory init

```text
crew init
```

Creates:

- `crew.yaml`
- `safety_policy.yaml`
- local Dispatch DB or connection placeholder
- repo registry
- default agent profiles
- default loops
- default hooks

### Repo scan

Detects:

- Git remote
- default branch
- language/stack
- package manager
- test command
- lint command
- coverage command
- CI config
- risky paths
- Memory tags

### Context packet generation

When an agent claims work, Crew builds a packet containing:

- ticket
- AC
- repo list
- branch policy
- safety policy
- relevant Memory records
- test/lint commands
- required skills
- known blockers
- evidence expectations

### Implementation loop

The standard work loop:

```text
claim ticket
assemble context
create branch
implement
run checks
record evidence
submit for review
suggest lore if needed
```

### Idle loops

When no claimable ticket exists, Crew can run controlled improvement loops.

Examples:

- coverage gap scan
- test quality scan
- design drift scan
- dead code scan
- documentation gap scan
- lore gap scan
- flaky test scan

Default output:

```text
draft Dispatch ticket with evidence
```

### Safety policy enforcement

Crew should evaluate:

- command allow/deny rules
- file write guards
- Git operation guards
- branch policies
- repo mutation modes
- approval requirements

### Hook execution

Hooks let users add behaviour at lifecycle points:

```text
before_claim
after_claim
before_context_packet
after_context_packet
before_implementation
after_tests
before_submit_review
after_ticket_done
on_blocked
on_idle
on_failure
on_lore_suggestion
```

## Non-goals for v1

- general agent swarm scheduler
- full workflow automation platform
- production deployment system
- policy marketplace
- GUI for every hook
- cloud SaaS
- direct protected branch mutation
- automatic approval of Memory suggestions

## Success criteria

Crew is successful when:

1. it can initialise a factory from existing repos
2. it can route an agent to Dispatch work
3. it builds a useful context packet
4. it prevents dangerous Git and filesystem operations by default
5. it can create draft work from idle scans
6. it records enough events to debug what happened
7. it integrates Memory without merging concerns

## MVP demo

```text
1. crew init
2. repo scan detects test and coverage commands
3. Dispatch has no ready tickets
4. idle coverage loop runs
5. Crew creates a draft Dispatch ticket
6. human marks it ready
7. agent claims the ticket
8. Crew supplies Memory context and branch policy
9. agent records AC evidence
10. ticket enters review
```
