# Security

## Threat model

`memory` is local-first by design. The threat model is:

1. **A compromised agent or sloppy prompt should not leak restricted records.**
   Mitigation: `restricted: true` records are excluded from default
   search; opting in requires an explicit flag, which is audit-logged.
2. **An agent's "suggest_lore" output should not poison the trusted set.**
   Mitigation: agent suggestions land as `status: draft`; default search
   ignores drafts; a human must run `memory approve <id>` to promote.
   Same gate applies to `report_conflict` — counter-records are drafts
   too, and the original they challenge is **never mutated** by the
   agent (one-way `conflictsWith` link; the reviewer resolves via the
   existing approve / supersede / reject lifecycle).

   **`record_absence` is the one MCP tool that, when enabled, lets
   agents bypass the review gate** — and v0.1 ships it **off by
   default** because of that. The CLI `memory absent record`
   works unconditionally (humans don't need a gate); MCP-side
   `record_absence` requires `MEMORY_ALLOW_MCP_ABSENCE=1` in the
   server's environment. Even when enabled the design is defensive:
   markers are low-stakes ("we checked, no policy here yet"),
   self-expiring (default 14 days, max 365) so a bad marker ages
   out, never appear as search results (only as a decoration on a
   zero-hit response) so they can't masquerade as canonical, and
   the audit row records only `queryChars`/`reasonChars` — never
   the text — so the audit log doesn't grow a parallel "what did
   the agent know" surface.
3. **Stale knowledge should not silently masquerade as authoritative.**
   Mitigation: records carry `reviewAfter`; search results carry
   `stale: true` when the date has passed; the CLI prints a warning.
4. **The server itself should not exfiltrate data.**
   Mitigation: `memory`'s application code uses stdio transport only and
   makes no outbound HTTP calls. No telemetry or analytics SDKs.
   The `@modelcontextprotocol/sdk` dependency does include unused
   HTTP/client modules; `memory` does not import or configure them.
   For defence in depth, see the OS-level egress block suggestion in
   the "Hardening for enterprise" section.

What's NOT in scope:

- DLP / access control. `restricted` is a retrieval guard, not a
  cryptographic barrier. Anyone with read access to the DB file can
  read every record. Don't store secrets in `memory`.
- Multi-user authentication. The DB file is a single-user local store.
  Team sync via `memory sync export/import` is git-mediated: the trust
  gate is your PR review, not a server-side auth layer.

## Defaults

| Setting | Default |
|---------|---------|
| Transport | stdio only (no HTTP server) |
| DB location | `~/.memory/lore.db` |
| DB file mode | `0600` (owner read/write) |
| DB parent dir mode | `0700` |
| Audit log | `~/.memory/audit.jsonl`, mode `0600`, append-only |
| Network egress | The `memory` application code uses stdio transport only and makes no outbound HTTP calls. The MCP SDK dependency includes unused HTTP/client modules; `memory` does not import or configure them. No telemetry or analytics SDKs. |
| Search excludes by default | `draft`, `deprecated`, `superseded`, `restricted` |
| `includeRestricted` via MCP | Ignored unless `MEMORY_ALLOW_RESTRICTED_MCP=1` is set in the server's environment. CLI is unaffected. |
| `get_lore` of a restricted id via MCP | Same gate as `includeRestricted`. With the gate off, `get_lore` returns a minimal refusal (`{ id, restricted: true, error: "restricted", hint: "..." }`) — no title, no summary, no body, no source — and audits the blocked attempt with `blocked: "restricted"`. With the gate on, returns the full record. CLI `memory show <id>` is unaffected. |
| `report_conflict` against a restricted id via MCP | **Always refused, regardless of `MEMORY_ALLOW_RESTRICTED_MCP`.** Returns `{ error: "restricted", hint: "... use the CLI" }` and audits `blocked: "restricted"`. Restricted records can be revised, but only by a human via `memory update` / `memory supersede` — agents can read them (when the env gate is on) but cannot draft counter-records against them. |
| Read tracking (`stats`) | Enabled by default — `searchLore` writes one `read` event per hit, `getLore` writes one per fetch. Both skip when `MEMORY_NO_TELEMETRY=1` or `MEMORY_AUDIT_OFF=1`. Events stay local in the SQLite `events` table; nothing crosses the network. |
| Stop-hook review nudge | Opt-in via `memory hooks install`. When enabled, fires once per Claude session if pending drafts exist (marker file under `~/.memory/hooks/`). Hook code never throws — failures silently log to stderr so a hook bug never blocks Claude stopping. |

## Audit log

Every MCP tool call lands in `~/.memory/audit.jsonl`:

```json
{
  "ts": "2026-05-16T11:32:18.412Z",
  "tool": "search_lore",
  "request": { "query": "password hashing", "repo": "payments-svc" },
  "resultCount": 2,
  "resultIds": ["7vk3qm9b", "h44z8n3q"]
}
```

A blocked `get_lore` for a restricted id (with `MEMORY_ALLOW_RESTRICTED_MCP`
unset) looks like:

```json
{
  "ts": "2026-05-16T11:33:02.118Z",
  "tool": "get_lore",
  "request": { "id": "7vk3qm9b" },
  "resultCount": 1,
  "resultIds": ["7vk3qm9b"],
  "blocked": "restricted"
}
```

Inspect with `memory audit --n 50`.

**What the audit log contains** (per-tool sanitisation shape):

- `search_lore` / `get_lore` — request arguments verbatim
  (`query`, `repo`, `tag`, `id`, etc.), result count, result IDs.
- `suggest_lore` — title, source URL, repos/tags, confidence, plus
  `summaryChars` / `bodyChars` (lengths only — never the text). The
  result ID. Over-cap inputs are audited with
  `error: "summary_too_long: <provided> > <max>"`.
- `report_conflict` — `existingId`, `observationChars` only (never
  the observation text), source URL, repos/tags. Result ID on
  success; `blocked: "restricted"` on a gated refusal; `error:
  "<reason>: <message>"` on a refusal (unknown id / non-active /
  restricted / empty / too long).
- `record_absence` — `queryChars` and `reasonChars` only (never the
  query or reason text — queries can carry proprietary domain terms
  and reasons can describe sensitive gaps), `repo`, `expiresInDays`,
  result ID.

**What the audit log never contains:**

- Body text of a suggested or updated record.
- Observation text from `report_conflict`.
- Query / reason text from `record_absence`.
- Full content of returned search results — only IDs.

Be aware: search queries and titles themselves can carry sensitive
intent (e.g. `query: "incident response key contacts"`). That's by
design — the audit log needs enough context to answer "what did Claude
see at 14:32?" — but it does mean the log file is itself sensitive.
Mode `0600` and the home-directory location are the access control.

CLI mutations (`add`, `approve`, `deprecate`, `supersede`, `verify`,
`update`, `delete`, `reject`) are NOT recorded in `audit.jsonl`. They
go into the SQLite `events` table, keyed by lore id, with timestamps,
event kind, and an optional JSON `payload`:

| Event kind | Payload | Emitted by |
|---|---|---|
| `created` / `imported` / `approved` / `deprecated` / `updated` / `deleted` | null | matching lifecycle command |
| `superseded` | `{ supersededBy: "<new-id>" }` | `supersedeLore` |
| `verified` | `{ reviewAfter: "<new-iso-date>" }` | `verifyLore` |
| `rejected` | `{ reason: "<text>" }` when the reviewer provided one (interactively or via `--reason "..."`); `null` otherwise | `rejectLore` |
| `conflict_reported` | `{ counterDraftId: "<draft-id>" }`; keyed to the **original** record's id | `reportConflict` |
| `read` | `{ via: "search" \| "get" }`; keyed to the hit/fetched id | `searchLore` / `getLore` — skipped if `MEMORY_NO_TELEMETRY=1` or `MEMORY_AUDIT_OFF=1` |

Query with `sqlite3 ~/.memory/lore.db 'SELECT * FROM events'`.

**Env knobs (all local; none reach the network):**

| Var | Effect |
|---|---|
| `MEMORY_AUDIT_OFF=1` | Silence both the MCP audit log AND `read` event tracking. The test suite sets this. |
| `MEMORY_NO_TELEMETRY=1` | Silence `read` event tracking only (audit log still records MCP tool calls). The "I just don't want stats counters" toggle. |
| `MEMORY_ALLOW_RESTRICTED_MCP=1` | Let MCP `search_lore` / `get_lore` see restricted records. Off by default. `report_conflict` is unconditionally blocked on restricted records regardless of this flag — agents can read but not challenge them. |
| `MEMORY_ALLOW_MCP_ABSENCE=1` | Let MCP agents write absence markers via `record_absence`. Off by default — the v0.1 default is "agents surface the gap, humans record via CLI." |
| `MEMORY_DB` | Override the SQLite path (default `~/.memory/lore.db`). |
| `MEMORY_AUDIT_LOG` | Override the audit log path (default `~/.memory/audit.jsonl`). |
| `MEMORY_REVIEW_NUDGE_EVERY_TIME=1` | (Stop-hook only) nudge every time instead of once per session. |

Disable MCP audit for tests with `MEMORY_AUDIT_OFF=1`. Not recommended
in production.

## Hardening for enterprise

- **Anthropic Zero Data Retention plan**: tokens used to generate the
  response are not retained on the provider side. Required if your data
  classification forbids any provider retention.
- **Self-hosted model**: data never leaves your network. The MCP server
  doesn't care which LLM client calls it.
- **OS-level egress block** on the `memory-mcp` binary (Little Snitch /
  nftables) — belt and braces. The server has no outbound code but a
  firewall rule proves it.
- **Pin dependencies**: `pnpm install --frozen-lockfile` in CI. We ship
  with a committed `pnpm-lock.yaml`.
- **Code audit**: dep tree is intentionally short. The full hot path is
  `better-sqlite3` (SQLite bindings), `@modelcontextprotocol/sdk` (MCP
  framework), and `zod` (input validation). No telemetry, no analytics,
  no auto-update.

## What about secrets in lore?

Don't put them there. `memory` is for *conventions and decisions*, not
credentials or tokens. If someone records "the prod API key is X" they
have made a mistake the tool can't fix.

The `restricted: true` flag exists to keep sensitive *knowledge* (e.g.
"the on-call rotation for SecOps is in PagerDuty group N") out of casual
searches, not to keep secrets out of the database. Secrets belong in a
secrets manager.
