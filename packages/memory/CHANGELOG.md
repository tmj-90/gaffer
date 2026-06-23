# Changelog

All notable changes to **memory-mcp**. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
itself is pre-1.0 so semver promises are best-effort.

## [Unreleased]

## [0.2.0] — 2026-05-30

### Removed — one cold-start path, not four

- **`memory induct` and `memory ingest-md` are gone.** The
  `/memory-onboard` skill is now the single cold-start path. The
  fixed-question interview produced generic records; doc-chunking
  produced ~80% noise that flooded the review queue and degraded the
  trust gate. Good lore needs judgement about what's durable — the skill
  (agent reads the repo, proposes grounded drafts with citations) does
  that; the mechanical paths didn't. Fewer doors, one of them good.
  `memory setup`'s cold-start nudge now points only at the skill.
  (The git-remote name parser the CLI still needs moved to `setup.ts`.)

### Added — cross-repo impact map (boundaries)

- **Boundary map: "change a contract here, what does it break there?"**
  A new typed record — `provides` / `consumes` edges over normalised
  contract names (events, endpoints, queues, tables, RPCs) — that
  aggregates across repos into a dependency graph.
  - `memory impact <contract>` — the headline query: who owns a
    contract and who depends on it (the consumers are the blast radius).
  - `memory boundary add|suggest|list|review|approve|reject|deprecate`
    — manage edges with the **same trust gate as lore**: agents declare
    drafts, a human ratifies.
  - MCP tools `find_dependents({contract})` (read — call before editing a
    cross-repo contract) and `declare_boundary({repo, contract, role,…})`
    (agent → draft). The MCP surface is now seven tools.
  - **Cross-repo by aggregation, not a server:** edges round-trip through
    `.memory/boundaries.jsonl`; `memory sync pull <parent>` merges
    every repo's map into one local DB. No daemon, no network.
  - Contract names are normalised (camelCase / kebab / snake all
    converge), so `OrderSubmitted` and `order-submitted` join — the
    failure mode that would otherwise make the map silently useless.
  - Schema migration `004-boundaries` (append-only; existing DBs migrate
    forward on next open).

### Changed

- **Trust-aware search ranking.** `search_lore` / `memory search`
  now re-rank FTS hits by relevance *adjusted for trust*: sourced,
  higher-confidence, non-stale records rank above low-trust near-ties,
  and a high-trust record bm25 buried just past `limit` can surface
  into the returned page. The adjustment is a bounded multiplier on each
  hit's own relevance magnitude (±0.5), so it reorders near-ties and
  rescues buried records but never overrides a clearly stronger lexical
  match — and behaves identically on tiny and large corpora.
- **Verified-absence markers now match on token-set containment** rather
  than an exact normalised key. A marker recorded for `"retry policy"`
  now fires on a search for `"payments-svc retry policy"` (and vice
  versa). Still conservative: mere token overlap (neither side a subset)
  does not match, preserving the "won't silently swallow unrelated
  searches" property.

### Added

- **Truncation signal on search.** When more records match than were
  returned, `search_lore` includes a `truncated: { shown, total, hint }`
  block and `memory search` prints `showing N of M matches`, so the
  caller narrows or raises `limit` instead of assuming the top page is
  the team's complete position.
- **`memory prune` — local-DB GC.** Deletes `read` audit events
  older than a window (default 90 days, matching the `stats` window)
  and expired absence markers; `--vacuum` reclaims disk, `--dry-run`
  reports counts. Lifecycle events are never touched. Closes the
  unbounded-growth leak on `events` from per-hit read tracking.
- **`memory suggest --from-commit <sha>`.** Drafts a record straight
  from a commit message (subject → title, first body paragraph →
  summary, full message → body) and auto-derives a commit permalink as
  the source from `remote.origin.url`. Closes the "I wrote the rationale
  in the commit, why retype it" capture gap (PRINCIPLES.md §6). Lands as
  a DRAFT; the reviewer promotes via `memory review`.

- **`/memory-onboard` skill — session-grounded capture pass.** A new
  Step 6 directs the agent, when invoked after real work in a session
  (not just a cold first-touch), to capture what it *learned* doing that
  work — gotchas, undocumented conventions, decision rationale — and to
  point the user at `suggest --from-commit` when the rationale already
  lives in a commit. The difference between transcribing a repo and
  capturing what was learned working in it.

### Tests

- Added a CLI dispatcher integration suite (`test/cli.test.ts`) driving
  `main(argv)` end-to-end against a temp DB — exit codes, flag-conflict
  refusals, and the add/search/show/review lifecycle — plus pure-helper
  coverage for `--from-commit` parsing and commit-URL derivation.
- **MCP server end-to-end suite (`test/mcp-server.test.ts`).** Drives the
  real server (new exported `buildMcpServer(db)`) through an in-memory
  transport and a real MCP `Client`, exercising every tool handler with
  its actual zod schema, env gates, redaction, and response shaping —
  the agent-facing layer that previously had only pure-helper coverage.
- **Direct unit suites for the previously-untested pure modules:** the
  flag parser (`args`), CLI renderers (`format`), id generator (`ids`),
  the agent retrieval rule (`instructions`), and `doctor` health checks.
- Deeper coverage for boundaries (lifecycle events, id-collision import,
  repo/role filters), trust ranking (multi-signal ordering, non-FTS
  recency), the audit log (timestamp, append, blocked field, AUDIT_OFF),
  and a full cross-repo `sync pull` → `impact` integration through the
  CLI. Suite grew from 314 to 479 tests.

### Internal

- `runMcpServer` split into a thin stdio shell plus an exported,
  testable `buildMcpServer(db)` that wires the tools onto a given DB.

### Fixed

- README now reports the correct `memory --version` (0.1.1).

## [0.1.1] — 2026-05-25

### Fixed

- **Migration version ceiling** — `openDb` now refuses, with an
  upgrade message, to open a database that carries migrations this
  binary doesn't ship (i.e. one written by a newer memory). The
  docs endorse a team-shared DB on a synced volume, so without this an
  older binary could write against a schema it doesn't understand and
  corrupt newer data. Both the CLI and the MCP server surface the
  remediation cleanly instead of a stack trace.

## [0.1.0] — 2026-05-25

First public release on npm. The initial-scope vs added-since split
below is kept for the changelog reader's benefit, not as a version
boundary — it all ships in 0.1.0.

### Added — robustness & packaging

- **`busy_timeout` on the SQLite connection** — a writer now waits up
  to 5s for a held lock instead of throwing `SQLITE_BUSY` immediately.
  memory's premise is multiple agents + the CLI sharing one DB;
  under WAL writers are serialised, so this is what keeps concurrent
  writes from surfacing "database is locked" to the agent.
- **Graceful MCP boot failure** — if the database can't be opened
  (locked, corrupt, unwritable dir) the server now emits an actionable
  diagnostic to stderr and exits cleanly, instead of crashing with a
  raw `SqliteError` stack before the protocol handshake.

### Added — agent-facing MCP surface

- **`report_conflict`** — agents can flag code-vs-lore disagreement.
  Creates a DRAFT counter-record linked to the original via
  `conflictsWith` (one-way; the original is never mutated by the
  agent). Reviewer triages via `memory review`. Distinct from the
  runtime `possibleConflicts` heuristic — this is explicit,
  persisted, evidence-backed disagreement.
- **`record_absence`** — agents can record "the team has no policy
  here" so future agents don't re-search the same gap. Self-expiring
  (default 14 days, max 365). MCP write is **off by default** in
  this release (`MEMORY_ALLOW_MCP_ABSENCE=1` to enable); the CLI
  `memory absent record|list` always works. Search responses
  surface an active marker as `absence_marker: { reason, ... }`
  alongside an empty `results` array.
- **Structured length errors** — `suggest_lore` and `report_conflict`
  now return `{ error: "summary_too_long" | "title_too_long",
  provided, max, suggested_cut, hint }` on over-cap input, instead
  of zod's opaque max-cap rejection. Agents can paste `suggested_cut`
  back as a corrected retry without a human round-trip.
- **`next` coach on zero-hit searches** — when `search_lore` returns
  empty AND no active absence_marker, the response includes a
  one-paragraph `next` field nudging three behaviours in priority
  order: `record_absence` if the gap is durable, `suggest_lore` at
  task end if you discover something, and retry without the `repo`
  filter for cross-repo conventions. Cheap; converts dead-ends into
  productive next steps at zero extra round trips.
- **WHEN-first tool descriptions** — the `description` field on each
  MCP tool now opens with **when to call**, not what the tool does.
  Acts as an ambient retrieval rule that works across skills that
  have zero memory awareness; the CLAUDE.md retrieval rule
  remains as belt.

### Added — search & retrieval

- **bm25 column weights** (title 3.0, summary 2.0, body 1.0) — title
  hits outrank body hits for the same query.
- **Opt-in prefix mode** — `prefix: true` (MCP) / `--prefix` (CLI)
  matches query tokens of 3+ chars as FTS5 prefixes. Off by default.
- **Multi-tag ANY-of** — `tag` accepts a string or `string[]`.
- **`includeSuperseded` surfaced** across MCP schema, CLI flag, and
  the README — core already honoured it; v0.1 just plumbed it through.
- **`possibleConflicts` overlap-heuristic** (formerly `conflicts`) on
  search hits when two active records share a repo + tag. CLI-only;
  stripped from MCP responses to avoid LLMs over-resolving the hint.
- **Always-OR FTS query parsing** + parser bounded by H1/H2 in
  ingest-md.

### Added — onboarding / cold-start

- **`memory setup`** — one-command bootstrap: register the MCP
  server with Claude Code, append the retrieval rule to CLAUDE.md
  (HTML-marker wrapped for idempotency), install
  `/memory-onboard` into `~/.claude/skills/`, and **detect
  cold-start sources** (CLAUDE.md, AGENTS.md, ADR dirs, top-level
  docs) with a [4/4] nudge toward the right next action — the skill
  by default, `memory induct` when the skill isn't installed,
  `memory ingest-md` as the bulk-mechanical fallback. Per-step
  opt-outs via `--skip-mcp`, `--skip-claude-md`, `--skip-skill`,
  `--skip-corpus-nudge`. `--dry-run` shows the plan without changes.
- **`/memory-onboard` skill** — repo-aware Claude onboarding
  interview that reads README/ADRs/migrations/recent commits and
  surfaces candidate drafts with source citations. CLAUDE.md /
  AGENTS.md / `.claude/CLAUDE.md` listed as the highest-priority
  survey source.
- **`memory induct`** — 10-question interview with `--short=5`
  subset. Drafts only; tagged `induction`; 90-day `reviewAfter`.
- **`memory demo`** — five illustrative records (including a
  draft and a stale record) tagged `demo`, with `--clean` for
  tag-based undo.
- **`memory ingest-md <glob>`** — bulk Markdown → drafts with
  section / tag / repo / source / dry-run flags; filename deny-list
  excludes README/LICENSE/CHANGELOG/CONTRIBUTING/etc.; content-shape
  scoring suppresses noise.

### Added — team workflow

- **`memory sync export/import`** — PR-reviewable Markdown
  round-trip in `.memory/<id>.md`. SQLite stays canonical;
  `.md` files are the sync artifact. Safe-import with `--force`
  and `--dry-run`; id/enum validation on incoming files.
- **`memory export --json`** — single-document JSON export
  (envelope `{ schemaVersion: 1, exportedAt, records }`, stable
  ordering).
- **`memory sync export --clean`** — remove stale `<id>.md`
  files (id-pattern guarded; hand-written `.md` files preserved)
  for deterministic mirror exports.

### Added — operations & visibility

- **`memory stats`** — local read-tracking aggregations: top-cited
  records, retirement candidates (active + no reads in N days),
  recent activity binned by event kind. `--evidence` pivots the
  audit log to show the actual queries that hit each top-cited
  record (stream-parsed; safe on large logs). `--json` for machine
  output. `MEMORY_NO_TELEMETRY=1` opts out of read tracking.
- **`memory hooks install`** — Claude Code SessionStart hook that
  nudges the user to run `memory review` once per session when
  pending drafts exist.
- **`memory audit`** — human-readable / `--raw` views of
  `~/.memory/audit.jsonl`. Audit shape is **per-tool sanitised**
  (lengths, not text, for `suggest_lore` summary/body and
  `record_absence` query/reason).
- **`memory doctor`** — health-check: DB perms, FTS index, audit
  log, restricted-MCP gate, version.
- **`rejection_reason` capture** — `memory reject <id> --reason
  "..."` and the interactive review prompt; reason lands on the
  `rejected` event payload. `getRejectionReason()` exported.

### Added — docs & positioning

- **Tagline reframed** as "Team-ratified knowledge for AI coding
  agents" — memory says what one session believes; memory says
  what the team has reviewed and approved.
- **"What deserves lore?"** section with explicit good-lore / bad-lore
  lists.
- **"Why not just CLAUDE.md? And why not generic agent memory?"**
  three-column comparison keyed on the trust source.
- **`docs/PRINCIPLES.md`** + cross-repo retrieval rule in the
  CLAUDE.md instructions.
- **`docs/SECURITY.md`** — explicit per-tool audit-row shape, the
  `report_conflict`-against-restricted refusal, read-tracking
  defaults, stop-hook safety.
- **`docs/DATA-FLOW.md`** — ASCII diagram + paths under
  `~/.memory/`.

### Changed

- **Product renamed** — package `memory-mcp`; CLI binary
  `memory`; MCP server binary `memory-mcp`. The noun "lore"
  stays for records (`LoreSummary`, `addLore`, `search_lore`, the
  SQL `lore` table, `lore.db` filename) — memory is what guards
  the lore.
- **Data directory** — `~/.lore/` → `~/.memory/`. Env vars
  `LORE_*` → `MEMORY_*` (hard rename, no fallback — only the
  initial single-user install existed at the time).
- **GitHub repo** — `todmj/lore-mcp` → `tmj-90/memory-mcp`
  (collapses two renames: the package rename and the subsequent
  GitHub account rename). All README install paths, package.json
  URLs, and JSDoc examples updated.
- **Summary cap** — `summary` field bumped from 500 → 800 chars.
  Real-usage feedback: 500 forced a teaser-shaped summary that
  required a follow-up `get_lore` to decide relevance; 800 fits one
  real paragraph including the *why*.
- **MCP `get_lore` on restricted records** — env-gated by
  `MEMORY_ALLOW_RESTRICTED_MCP` (same gate as `search_lore`).
  Default returns a minimal refusal (no title / summary / body);
  audits `blocked: "restricted"`.
- **`possibleConflicts` overlap field** — renamed from `conflicts`
  to be honest about what the heuristic proves (shared scope, not
  contradiction). CLI marker reads "⚠ possibly conflicts with …".
- **`memory stats` window labels** — section headers now reflect
  the actual `--since-days` / `--quiet-for-days` values rather than
  hardcoding "90 days" / "180 days" / "30 days" when the caller
  overrode them.

### Fixed

- **`suggest_lore` validation masking** — over-cap inputs used to
  fail through zod's max-cap path and surface as "body is undefined"
  upstream. Now structured `{ error, provided, max, suggested_cut }`.
- **External-review correctness pass** — public-API hardening +
  trust-gate clarifications.
- **Markdown frontmatter parser robustness** — H1/H2 boundaries
  respected; always-OR FTS to fix near-miss searches.

### Security

- **`get_lore` restricted gate** closes the asymmetry where an agent
  with a known id could fetch the body even with `includeRestricted`
  defaulted off in `search_lore`.
- **`report_conflict` against restricted records** is always refused,
  regardless of the env gate, with a structured response. Restricted
  records can be revised by humans via `memory update` /
  `memory supersede`; agents can't draft against them.
- **Audit log per-tool sanitisation** — `summary_lore` / lore body
  text never leaves the in-memory request; `record_absence` query /
  reason captured as character counts only.

### Initial scope (carried into v0.1.0)

Trust gate, MCP surface, human-approval flow, restricted handling,
audit log boundary, FTS search, 5-minute demo walkthrough, lifecycle
commands.
