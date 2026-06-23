# Crew runtime architecture

## Verdict

Crew should start as a thin runtime and CLI, not a big distributed platform.

It should read config, orchestrate loops and enforce safety around calls to Dispatch, Memory, Git, filesystem and shell.

## Components

### crew-core

Pure domain and orchestration library.

Responsibilities:

- load config
- validate config
- build context packets
- evaluate safety policies
- run loops
- invoke hooks
- route work to agents
- call Dispatch client
- call Memory client
- record runtime events

### crew-cli

Human/operator entry point.

Commands:

```text
crew init
crew scan-repos
crew run
crew run-loop implementation
crew run-loop idle-coverage
crew validate-config
crew explain-policy
crew doctor
```

### crew-mcp

Optional MCP server exposing factory-level tools.

Tools:

- get_factory_status
- list_agents
- list_repos
- get_context_packet
- run_idle_loop
- explain_safety_policy
- check_command_allowed
- check_path_write_allowed

Agent implementation should usually still claim tickets through Dispatch, not Crew.

### Adapters

Adapters should isolate external systems:

```text
dispatch_client
memory_client
git_adapter
filesystem_adapter
shell_adapter
ci_adapter optional
github_adapter optional
```

## Runtime flow: implementation loop

```text
1. Load factory config.
2. Register or validate agent identity.
3. Ask Dispatch for next claimable ticket.
4. If no ticket, trigger configured idle policy.
5. If ticket claimed, build context packet.
6. Search Memory for repo/task relevant knowledge.
7. Validate branch policy.
8. Create or verify working branch.
9. Hand packet to agent runtime.
10. Guard shell, Git and filesystem operations.
11. Capture evidence.
12. Submit ticket for review in Dispatch.
13. Trigger Memory suggestion flow if durable knowledge emerged.
14. Release or complete claim.
```

## Runtime flow: idle loop

```text
1. Dispatch reports no claimable work.
2. Crew selects enabled idle loop.
3. Loop inspects allowed repo roots.
4. Loop gathers evidence only.
5. Loop creates draft Dispatch ticket.
6. Human or policy can refine/approve later.
```

Default rule:

```text
idle loops create draft tickets, not code changes
```

## Context packet

The context packet is a major product primitive.

### Contents

```json
{
  "factory": {
    "name": "example-factory",
    "mode": "local_strict"
  },
  "agent": {
    "id": "claude-auth-01",
    "capabilities": ["backend", "auth", "tests"],
    "max_risk": "medium"
  },
  "ticket": {},
  "acceptance_criteria": [],
  "repositories": [],
  "branch_policy": {},
  "safety_policy": {},
  "relevant_lore": [],
  "skills": [],
  "verification": {
    "test_commands": [],
    "lint_commands": [],
    "coverage_commands": []
  },
  "constraints": [],
  "evidence_expectations": [],
  "forbidden_actions": []
}
```

### Why it matters

Bad agent start:

```text
Here is a ticket. Figure it out.
```

Good agent start:

```text
Here is a work packet with ticket, AC, repo commands, branch policy, safety constraints, relevant lore and evidence expectations.
```

## Runtime events

Crew should have its own runtime event stream, separate from Dispatch's domain event log.

Examples:

```text
factory_started
config_loaded
agent_registered
loop_started
loop_finished
safety_check_denied
command_requires_approval
context_packet_built
lore_lookup_completed
idle_ticket_created
hook_started
hook_failed
```

Some Crew events should also be mirrored into Dispatch when tied to a ticket.

## Hook architecture

Hooks should be declarative.

Example:

```yaml
hooks:
  after_tests:
    - id: attach_test_evidence
      type: builtin
  on_idle:
    - id: coverage_gap_scan
      type: builtin
```

Hook result:

```json
{
  "hook_id": "coverage_gap_scan",
  "status": "success",
  "events": [],
  "created_ticket_ids": ["ticket_123"],
  "evidence": []
}
```

Hooks must not silently bypass safety policy.

## Agent runtime boundary

Crew should not assume one agent vendor.

Interface:

```text
AgentRuntime.run(packet) -> AgentRunResult
```

Result:

```json
{
  "status": "submitted_for_review",
  "summary": "Implemented password reset.",
  "evidence": [],
  "decisions": [],
  "lore_suggestions": []
}
```

This allows Claude Code, Cursor, OpenAI Codex-style agents or local scripts later.

## Approval requests

Some actions should return approval-needed rather than fail hard.

Example:

```json
{
  "allowed": false,
  "requires_approval": true,
  "reason": "npm install modifies dependency lockfile and is approval-gated in this factory."
}
```

## Deployment model

### v1 local

```text
crew CLI
→ local Dispatch SQLite
→ local Memory
→ local repos
→ stdio MCP
```

### v2 shared

```text
crew runtime
→ Dispatch server/Postgres
→ Memory server or CLI-backed service
→ repo hosts and CI adapters
→ authenticated MCP clients
```

## Architecture anti-patterns

Avoid:

- Crew directly editing Dispatch DB tables
- hooks running unrestricted shell commands
- agent runtime seeing DB credentials
- context packet containing secrets
- idle loops mutating code by default
- direct pushes to protected branches
- mixing skills with durable lore
