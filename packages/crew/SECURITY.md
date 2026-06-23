# Security & Trust Model

Crew runs autonomous (or semi-autonomous) coding agents against real
repositories. Its security posture is built on one principle: **the agent is
never the security boundary.** Everything an agent does that could be dangerous
is gated by deterministic, agent-independent controls.

## The boundary: a deterministic PreToolUse hook

The enforcement point is a **deterministic safety decision** computed *before*
any mutating action runs — the PreToolUse boundary. Given a command, a file
write, or a branch operation, the policy returns one of three values:

- `allowed` — proceed.
- `needs_approval` — a human must sign off; the action does not run until then.
- `denied` — the action never runs.

The decision is a pure function of the command/path/branch and the loaded
`safety_policy.yaml`. It does **not** consult the agent, the model, or any
prompt. The same input always yields the same decision. See
`src/safety/` (`commandGuard`, `fsGuard`, `branchPolicy`, `gitGuard`) and
`explain_safety_policy` / `check_command_allowed` / `check_path_write_allowed`
in the MCP surface.

## Agents cannot self-approve

There is no code path by which an agent's output can flip a `denied` or
`needs_approval` decision to `allowed`. Approval is a *human* act that happens
outside the agent's control loop. Specifically:

- The MCP tools an agent can call are **read-only or draft-only**. The single
  mutating tool, `run_idle_loop`, can only create **draft** Dispatch tickets —
  it never edits code, claims work, readies tickets, or touches git.
- Idle-loop findings land as drafts that a human promotes to *ready*. An agent
  cannot promote its own work.
- The safety policy is loaded from disk at startup; agents have no tool to mutate
  it.

## Secrets never enter the agent's context

- **Context packets are assembled and redacted programmatically.** When an agent
  asks for work via `get_context_packet`, Crew builds the packet (ticket,
  acceptance criteria, repo paths/commands, branch policy, relevant lore) and
  runs **every free-text field through secret redaction** before returning it
  (`src/safety/redaction.ts`, `src/context/packet.ts`). The packet is the
  *sanctioned* view — agents are coached to prefer it over reading raw rows or
  `.env` files.
- **Secret files are write-denied and read-gated.** Writes to `.env` and similar
  secret files are denied or approval-gated by the filesystem guard. Reading
  secret files is off by default (`model_may_read_secret_files: false`).
- **High-entropy redaction** strips token-shaped strings from context even when
  they aren't in a known secret file.

## Branch & command guards

- **Branch policy:** work happens on correctly-prefixed branches; protected
  branches (`main`, `release/*`, …) reject direct pushes; force-push, branch and
  tag deletion, and rebases of shared branches are denied.
- **Command policy:** risky commands (destructive git, untrusted installs) are
  denied or approval-gated. A repo may *widen* its own allow-list only within the
  bounds the policy permits.

## Audit log

Every MCP tool call is recorded to an **append-only, content-redacted** audit log
(`src/audit/`). Each line records *that* a tool ran and the ids/counts it touched
— tool name, ticket/repo/skill/draft ids, result counts, and any error code. It
**never** records prompts, file contents, ticket/lore bodies, commands, paths, or
secrets: free-text arguments are reduced to a character count by `summariseArgs`
before they reach the log. The log is written `0600` under a `0700` directory.

Configuration:

- Path: `GAFFER_AUDIT` env var, else `<factory>/audit.jsonl`, else
  `~/.crew/audit.jsonl`.
- Disable: `GAFFER_AUDIT_OFF=1` (a write-failure never breaks a tool call either
  way — auditing is strictly best-effort).

`crew stats` reads this log to report recent run outcomes.

## Defensive startup

Config, safety-policy, and subsystem-connection failures surface as structured
`CrewError`s with actionable guidance, never as raw stack traces:

- The CLI prints `{ ok: false, code, message, details }` and exits non-zero.
- The `crew-mcp` server prints a multi-line, code-specific diagnostic to
  stderr (which MCP clients surface on launch failure) and exits cleanly.
- `crew doctor` runs the full readiness check (config valid, repos resolve,
  active agents, Dispatch/Memory reachable, skills loaded, safety policy sane,
  audit log writable and — when it already exists — owner-only `0600`/`0700`) and
  exits non-zero only on a hard failure.

## Reporting a vulnerability

This is a local-first, pre-release runtime. If you find a way for an agent to
bypass a `denied`/`needs_approval` decision, to get a secret into a context
packet, or to write content into the audit log, please open a private report to
the maintainer rather than a public issue.
