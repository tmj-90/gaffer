# Crew agent and repo registry

## Verdict

Crew needs explicit registries for agents and repositories. Without them, every loop becomes guesswork and every safety rule becomes weaker.

## Agent registry

An agent profile tells the factory what the agent is allowed and expected to do.

### Agent fields

```text
id
display_name
runtime
model
host
capabilities
max_risk
allowed_repos
denied_repos
status
created_by
last_seen_at
```

### Example

```yaml
agents:
  - id: claude-auth-01
    display_name: Claude Auth Implementer
    runtime: claude-code
    model: claude-sonnet
    host: local
    capabilities:
      - backend
      - auth
      - tests
    max_risk: medium
    allowed_repos:
      - auth-service
      - web-app
    status: active
```

## Capability routing

Tickets declare required capabilities. Agents declare capabilities.

An agent can claim a ticket if:

```text
ticket.required_capabilities is subset of agent.capabilities
and ticket.risk_level <= agent.max_risk
and ticket.repo set intersects allowed repos
and ticket has no blocking decisions
and no active claim exists
```

Suggested capabilities:

```text
frontend
backend
tests
docs
auth
payments
infra
database_migration
security_review
design_review
multi_repo
refactor
ci
```

## Agent health

Crew should track:

- last heartbeat
- active claim count
- failed attempts
- recent policy denials
- average ticket completion time later

Agent statuses:

```text
active
paused
disabled
unhealthy
```

If an agent repeatedly fails tickets or triggers safety denials, pause it or require human inspection.

## Repo registry

A repo profile tells Crew how to operate safely in that repository.

### Repo fields

```text
id
name
path
remote_url
default_branch
protected_branches
stack
package_manager
test_command
lint_command
coverage_command
build_command
mutation_mode
risk_level
owners
lore_tags
skills
```

### Example

```yaml
repos:
  - id: auth-service
    name: auth-service
    path: ./repos/auth-service
    remote_url: git@github.com:org/auth-service.git
    default_branch: main
    protected_branches:
      - main
      - release/*
    stack: python
    package_manager: poetry
    test_command: poetry run pytest
    lint_command: poetry run ruff check .
    coverage_command: poetry run pytest --cov=auth_service
    mutation_mode: branch_only
    risk_level: high
    owners:
      - platform
      - security
    lore_tags:
      - auth
      - security
      - python
```

## Repo scan

Crew should infer reasonable defaults, then ask humans to confirm.

Detect:

- Git remote
- default branch
- protected branch names from config or heuristics
- language stack
- package manager
- test commands
- lint commands
- coverage commands
- CI files
- Docker/infra files
- migrations
- likely secret paths

Detection examples:

```text
pyproject.toml → Python/Poetry
package.json → Node/React/TypeScript depending scripts
pnpm-lock.yaml → pnpm
pytest.ini → pytest
ruff.toml → ruff
.github/workflows → GitHub Actions
terraform/*.tf → infra risk
alembic/versions → DB migrations
```

## Repo risk

Default risk mapping:

```text
auth, payments, security, infra, migrations → high
web UI, docs, test-only changes → medium or low
dependencies, CI, deployment config → high
```

Risk should be human-adjustable.

## Owner routing

Repos can have owners.

Use owners for:

- review assignment
- decision escalation
- high-risk approval
- Memory suggestion review

## Workspace model

A factory can contain multiple repos:

```text
factory root
  crew.yaml
  safety_policy.yaml
  repos/
    auth-service/
    web-app/
    billing-service/
```

But it should also support arbitrary paths:

```yaml
repos:
  - name: auth-service
    path: /Users/you/code/auth-service
```

## Worktree rules

Before implementation:

- verify repo exists
- verify `.git` exists if mutation is required
- verify default branch exists
- verify working tree is clean or policy allows dirty
- verify current branch is not protected
- create ticket branch if needed

## Multi-repo tickets

For tickets spanning repos, Crew should create per-repo status.

Example:

```text
TICKET-123 Add password reset
  auth-service: branch created, PR open
  web-app: branch created, PR open
```

Do not mark ticket done because one repo succeeded.

## Agent assignment examples

### Backend auth ticket

Required:

```text
backend
auth
tests
```

Allowed agents:

```text
claude-auth-01
```

Denied agents:

```text
docs-agent-01
frontend-only-agent
```

### Documentation ticket

Required:

```text
docs
```

Allowed:

```text
docs-agent-01
claude-general-01
```

### Critical migration ticket

Required:

```text
database_migration
backend
```

Risk:

```text
critical
```

Default policy:

```text
agent can plan only, human must approve implementation
```
