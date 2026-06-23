# Crew safety policies

## Verdict

Default-offline local mode reduces risk, but it does not make the system safe by itself.

Crew should protect against over-permissioned local agents, destructive Git operations, secret exposure, risky filesystem writes and unsafe commands.

## Safety posture

Use this language:

```text
local-first and safe-by-default
```

Do not use this language:

```text
local is safe and perfect
```

Local removes large classes of network risk. It does not remove local destructive-action risk.

## Safety layers

1. Git policy
2. Filesystem policy
3. Command policy
4. Repo mutation mode
5. Approval policy
6. Secret redaction
7. Context-packet hygiene
8. Event logging

## Git protections

### Default denied

```text
git push --force
git push -f
git push --mirror
git branch -D
git tag -d
git reset --hard origin/main
git clean -fdx
git push origin :branch-name
```

### Protected branches

Default protected names:

```text
main
master
develop
production
release/*
hotfix/*
```

Default policy:

- no direct commits
- no direct push
- no delete
- no force push
- no rebase without approval if branch is shared

### Required branch prefix

Default:

```text
dispatch/
```

Examples:

```text
dispatch/TICKET-123-password-reset
dispatch/coverage-auth-service-2026-06-20
```

### Branch creation rule

Allowed only if:

- current worktree is clean or user allows dirty worktree
- source branch is protected/default branch or configured base branch
- branch name matches policy
- ticket claim is valid, if tied to a ticket

## Filesystem policy

### Allowed roots

Crew should only allow reads/writes under configured repo roots by default.

Example:

```yaml
filesystem:
  allowed_roots:
    - ./repos/auth-service
    - ./repos/web-app
```

### Denied writes

Default deny:

```text
.git/**
.env
.env.*
**/secrets/**
**/credentials/**
**/*.pem
**/*.key
**/id_rsa
**/id_ed25519
**/.aws/**
**/.ssh/**
```

### Approval-required writes

Default approval:

```text
.github/workflows/**
infra/**
terraform/**
k8s/**
Dockerfile
docker-compose.yml
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
poetry.lock
requirements.txt
migrations/**
```

Rationale: these files can change build, deployment, dependencies or data shape.

## Command policy

### Deny list

```text
rm -rf /
rm -rf .git
chmod -R 777
chown -R
git push --force
git push -f
git clean -fdx
git branch -D
git tag -d
terraform destroy
kubectl delete
docker system prune -a
```

### Approval-required commands

```text
git reset --hard
git rebase
npm install
pnpm install
yarn install
pip install
poetry add
cargo update
docker compose down -v
terraform apply
kubectl apply
```

### Allowed commands

Allow by repo config, not globally.

Examples:

```yaml
commands:
  allow:
    - "pytest"
    - "npm test"
    - "npm run lint"
    - "npm run typecheck"
```

## Secret redaction

Crew should redact likely secrets before anything enters model context or an event payload.

Patterns:

- API keys
- private keys
- tokens
- connection strings
- `.env` values
- AWS/GCP/Azure credentials
- GitHub tokens
- database passwords

Suggested behaviour:

```text
read denied for known secret paths
redact high-entropy strings in logs
redact env var values
never include full secret-like lines in context packet
```

## Context-packet hygiene

Context packets should include constraints and commands, not secrets.

Allowed:

```text
repo path
test command
lint command
coverage command
branch policy
relevant Memory summaries
AC
```

Denied:

```text
DB password
GitHub token
SSH key
.env contents
cloud credentials
production secrets
```

## Repo mutation modes

Set per repo:

```text
read_only
branch_only
branch_and_pr
local_commit_allowed
direct_push_allowed
```

Default:

```text
branch_only
```

Meaning:

- agent can create an allowed branch
- agent can modify working tree under repo root
- agent cannot push unless configured
- agent cannot touch protected branches

## Approval model

Policy result should be explicit.

```json
{
  "allowed": false,
  "requires_approval": true,
  "reason": "Command modifies dependency lockfile and is approval-gated.",
  "approval_scope": "command:npm install"
}
```

Approvals should be time-bounded and scoped.

Bad approval:

```text
allow agent to do risky stuff
```

Good approval:

```text
allow claude-auth-01 to run npm install in web-app for ticket TICKET-123 until 13:00
```

## Safety policy config

See `examples/safety-policy-example.yaml` for a complete example.

## Local mode security stance

Local mode should use:

- SQLite file
- local filesystem permissions
- no network listener by default
- no model-visible DB credentials
- explicit repo roots
- denied secret paths
- safety wrappers for shell/Git operations

## Shared mode security stance

Shared mode should use:

- Postgres
- server-side DB credentials
- authenticated users and agents
- scoped MCP tool access
- role-based decision resolution
- audit logs
- TLS
- secret manager or env-based server config

The model should never receive the DB connection string.

## Failure handling

If safety policy blocks an action:

1. do not execute the action
2. return a structured denial
3. record a runtime event
4. optionally create an approval request
5. do not let the agent self-approve

## Safety tests

Required tests:

- force push denied
- protected branch push denied
- write to `.env` denied
- write outside repo root denied
- `rm -rf .git` denied
- dependency install requires approval
- migration file write requires approval in strict mode
- context packet redacts secret-like values
- agent cannot bypass through hook
