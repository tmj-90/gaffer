# Security & Trust Model

Crew runs autonomous (or semi-autonomous) coding agents against real
repositories. Its security posture is built on one principle: **the agent is
never the security boundary.** Everything an agent does that could be dangerous
is gated by deterministic, agent-independent controls.

## The boundary: a deterministic PreToolUse hook

The enforcement point is a **deterministic safety decision** computed _before_
any mutating action runs — the PreToolUse boundary. In the live factory that is
`runner/safety-hook.mjs` (with its deny list in `runner/lib/dangerous-commands.mjs`):
Claude Code runs it before every tool call of every factory agent, and it either
allows the call (exit 0) or blocks it (exit 2). It scopes writes to the ticket's
worktrees, blocks secret reads, denies the control-plane CLI and raw writes to
the factory databases, and fails closed. It does **not** consult the agent, the
model, or any prompt, and the same input always yields the same decision.

**The hook does not read `safety_policy.yaml`.** That file drives crew's own
TypeScript classifier (`src/safety/`: `commandGuard`, `fsGuard`, `branchPolicy`,
`gitGuard`), which returns one of three values:

- `allowed` — proceed.
- `needs_approval` — a human should sign off.
- `denied` — the action should never run.

That classifier is **advisory**. It is enforced only inside the mock `crew run`
loop; in the live factory it answers questions (`crew safety check`,
`explain_safety_policy`, `check_command_allowed`, `check_path_write_allowed`).
The two mostly agree, but not always. The hook blocks things the policy allows
(e.g. `sqlite3 dispatch.sqlite 'delete …'`), and the policy's `needs_approval`
tier and any custom `deny` entry you add to `safety_policy.yaml` are **not**
enforced at runtime. So `crew safety check --command` / `--path` and the two MCP
check tools also run the live hook on the same input and report its verdict as
`enforced` (`commandEnforced` / `pathEnforced` in the CLI), with a `mismatch`
note whenever the two disagree. Editing `safety_policy.yaml` does not tighten the
live factory; changing what agents may do means changing the hook.

## Agents cannot self-approve

There is no code path by which an agent's output can flip a `denied` or
`needs_approval` decision to `allowed`. Approval is a _human_ act that happens
outside the agent's control loop. Specifically:

- Every MCP tool an agent can call is **read-only** except one. The single
  mutating tool, `run_idle_loop`, runs one idle tick (the same as `crew idle`):
  it files findings as Dispatch tickets and never edits code, claims work, or
  touches git.
- Idle-loop findings land as drafts that a human promotes to _ready_, unless
  the OPERATOR configured otherwise: a loop with `mode: create_ready_tickets`,
  or `loops.self_improve` (off by default, opt-in per repo, low risk only)
  promoting a finding. An agent cannot promote its own work.
- The safety policy is loaded from disk at startup; agents have no tool to mutate
  it.

## Secrets never enter the agent's context

- **Context packets are assembled and redacted programmatically.** When an agent
  asks for work via `get_context_packet`, Crew builds the packet (ticket,
  acceptance criteria, repo paths/commands, branch policy, relevant lore) and
  runs **every free-text field through secret redaction** before returning it
  (`src/safety/redaction.ts`, `src/context/packet.ts`). The packet is the
  _sanctioned_ view — agents are coached to prefer it over reading raw rows or
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
  denied or approval-gated. A repo may _widen_ its own allow-list only within the
  bounds the policy permits.

## Audit log

Every MCP tool call is recorded to an **append-only, content-redacted** audit log
(`src/audit/`). Each line records _that_ a tool ran and the ids/counts it touched
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
