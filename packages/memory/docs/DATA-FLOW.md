# Data flow

```
┌──────────────────┐         ┌──────────────────┐         ┌────────────────────────┐
│  ~/.memory/lore.db │  ◀────▶ │ memory-mcp    │  stdio  │  Claude Code / Cursor  │
│  (SQLite, 0600)  │         │   (subprocess)   │  ─────▶ │  / your MCP client     │
└──────────────────┘         └──────────────────┘         └────────────┬───────────┘
                                                                       │
                                                                       │ HTTPS
                                                                       ▼
                                                          ┌─────────────────────────┐
                                                          │  LLM provider           │
                                                          │  (Anthropic / OpenAI /  │
                                                          │   self-hosted)          │
                                                          └─────────────────────────┘
```

What crosses each boundary:

| From | To | What | Notes |
|------|----|------|-------|
| SQLite file | `memory-mcp` process | Query results (rows) | In-process; never leaves the local subprocess as bytes on the wire. |
| `memory-mcp` | MCP client | JSON tool-call results over stdio | Subprocess pipes only — no network. Audit log records every call. |
| MCP client | LLM provider | Tool results inlined into the next prompt | This is the data-egress point. Standard trust boundary you already accept for any AI tool use. |

## What never crosses any boundary

- The full audit log (`~/.memory/audit.jsonl`) stays local. The MCP server
  never emits audit lines as tool results.
- The DB file is never read by the MCP server other than through SQL
  queries — there's no "dump the whole table" tool.
- The `events` table (which now also records `read` events — one per
  search hit and one per `getLore` fetch, used by `memory stats`)
  stays local. The word "telemetry" in `MEMORY_NO_TELEMETRY` is
  historical — there is no outbound telemetry to disable; the env var
  silences the local counters.
- Stop-hook session markers (`~/.memory/hooks/session-<id>.nudged`)
  stay local. The hook reads Claude's stdin and emits stdout — no
  network or filesystem outside the user's home dir.
- The `memory` application code makes no outbound HTTP calls. `package.json`
  deliberately has no `axios` / `node-fetch` / telemetry SDKs. The
  `@modelcontextprotocol/sdk` dependency does include unused HTTP/client
  modules; `memory` does not import or configure them. For defence in depth,
  an OS-level egress block on the binary (Little Snitch / nftables) closes
  the gap regardless of dep-tree contents.

## What does leave your machine

Once Claude reads a search result, that result is in the model's context.
On the model provider's side:

- **Anthropic (default)**: standard inference path. Tokens retained per
  their published policy.
- **Anthropic enterprise with ZDR**: tokens not retained.
- **Self-hosted model**: never leaves your network.

If you have records marked `restricted: true`, **set `includeRestricted`
to false by default** in any agent's system prompt. The MCP tool already
defaults to false, but a sloppy prompt could ask the agent to pass `true`.
The audit log will show every time it does.

## Storage location

- DB: `~/.memory/lore.db` (mode `0600`, parent dir `0700`)
- Audit: `~/.memory/audit.jsonl` (mode `0600`)
- Stop-hook session markers: `~/.memory/hooks/session-<id>.nudged`
  (zero-byte files; existence is the signal)
- Override DB / audit paths via `MEMORY_DB` / `MEMORY_AUDIT_LOG`
  env vars (useful for team-shared DBs on a synced volume or for test
  fixtures).
- Opt out of read tracking via `MEMORY_NO_TELEMETRY=1` (only
  silences the `read` events in the `events` table — does not touch
  audit). `MEMORY_AUDIT_OFF=1` silences both.
