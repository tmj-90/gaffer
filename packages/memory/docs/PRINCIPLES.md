# Principles

The architectural commitments behind memory. Read this before
proposing a feature that changes the data model or the trust loop:
several "obvious" upgrades have been considered and left out, and the
reasoning is worth knowing first.

## 1. SQLite is the canonical store. Markdown is a sync artifact.

The lore lives in `~/.memory/lore.db`. The `.memory/<id>.md`
files in a repo are the **PR-reviewable** projection of the canonical
records, round-trippable via `memory sync export/import`.

**Considered:** flipping the model so Markdown is canonical (the way
ADRs and CLAUDE.md live as files in the repo) and SQLite is a derived
FTS cache.

**Rejected because:**

- Well-indexed FTS5 + restricted/draft gating + atomic state
  transitions are *much* simpler against a relational store than
  against a file tree.
- Token economy: the agent learns one schema once; the well-indexed
  shape produces compact, targeted hits. File-tree scans plus
  ad-hoc grep patterns burn more tokens per query.
- The state machine (draft → active → deprecated → superseded) has
  invariants (e.g. "supersedeLore atomically writes one row + emits
  one event") that need a transaction, not a file move.

If the team workflow drifts toward "edit the .md, PR it, merge" as
the primary capture motion, that's the signal to revisit. The sync
layer is already symmetric enough that the flip would be
back-compat. Until then, the SQLite-canonical posture stays.

## 2. Lore is for what the agent CAN'T derive from code

This is the deepest principle. Reach for it whenever you're about to
propose a feature that helps the agent navigate *structure*: stop and
ask whether the agent could derive that from the code itself.

**The agent already has, natively, for free:**

- Call graph traversal (grep + import analysis + LSP if available)
- Route definitions (`POST /api/foo`) and their handlers
- Payload schemas (OpenAPI / proto / TS type signatures)
- Who calls what, both intra-repo and across repos in the same workspace
- The current state of any convention (what the code does *today*)

**Lore covers only what the code can't tell you:**

- **Why** a decision was made ("Argon2id over scrypt because of
  INC-411"), the code shows the choice, not the reasoning
- **What NOT to do** that the code may still contain (deprecated
  patterns the team is migrating away from but haven't deleted)
- **Cross-team policy** ("payments-svc team won't accept retries
  longer than 2h per their SLA")
- **Incident context** and the lessons distilled from it
- **Staleness / freshness signals** ("this rule was true as of
  2025-Q3; revisit if INC-NNN repeats")
- **Banned vocabulary / lint-rule rationale** that future
  implementers should respect

**The corollary:** any proposed feature whose value is "the agent can
now traverse X faster" should be tested against "could the agent do
this with Grep + Read in three tool calls?" If yes, the feature is
probably premature optimisation, not a real upgrade.

**Concrete example of this principle rejecting a feature:** see the
"typed records + cross-repo call-chain links" idea (drafted, then
rejected). The pitch was "agent in backend sees the matching client
record automatically via a `linksTo` field." The reframe: the agent
can find the matching client code by walking routes, then search
lore by token, no persisted links needed. A persisted link layer
would be a *cache* of what the agent can re-derive, and caches need
maintenance (stale on rename, missing on new routes, dead on
deletion). Search-by-FTS plus a `repos: [...]` array already covers
the cross-repo discovery; the link layer is solving the wrong half
of the problem.

## 3. Agents suggest; humans approve

Agents can call `suggest_lore` and `report_conflict`, both land as
drafts hidden from default search. Promotion to `active` is CLI-only;
there is no MCP approval path. This is the core poisoning-prevention
guard.

**One deliberate exception:** `record_absence`. It's *opt-in* (env
gate `MEMORY_ALLOW_MCP_ABSENCE=1`), self-expiring (default 14
days), and the records it produces never appear as search results
(only as decorations on zero-hit responses). The exception exists
because absence markers are low-stakes by design.

**Restricted records are unconditionally beyond agent write:** the
env gate opens `search_lore` / `get_lore`, but `report_conflict`
against a restricted record is always refused regardless. Restricted
revision is human-only via CLI.

## 4. Local-only by construction

No telemetry, no outbound HTTP, no analytics SDKs. Read tracking
(`stats`), audit log, hook session markers, all live under
`~/.memory/`. The "telemetry" naming on
`MEMORY_NO_TELEMETRY=1` is historical; there is no outbound
telemetry to disable. See `docs/DATA-FLOW.md` for the diagram.

If you find yourself reaching for a network call, stop. The
trust posture is "your machine, your data, your audit log."

## 5. Deliberately left out

- **Server-side dedup of `suggest_lore` / `report_conflict`.** The reviewer
  triages duplicates in the review queue; auto-dedup would hide what the human
  should see.
- **Bidirectional `conflictsWith` back-references.** They would need the agent
  to mutate the original record, which breaks principle 3.
- **Auto-promotion of onboarding drafts.** The point of the queue is the human
  review beat.
- **Mechanical cold-start** (a fixed-question interview, chunking docs into
  records). It produces generic records and floods the queue; the
  `/memory-onboard` skill (the agent reads the repo and proposes grounded
  drafts) is the one cold-start path.
- **Model-backed semantic search.** Retrieval fuses FTS5 bm25 with a built-in,
  credential-free hashed n-gram vector per record (`core/embedding.ts`), which
  recovers typos, joined or split compounds and subwords without a model, a
  network call or a second store. A model-backed embedder fits behind the same
  `Embedder` interface if the labelled eval set
  (`test/retrieval-eval.test.ts`) ever shows misses the n-gram space cannot
  close.
- **A web UI or server mode.** The MCP server is stdio-only, with no HTTP
  listener.

Cross-repo boundaries are the one typed record: `provides` / `consumes` edges
over contract names (`declare_boundary`, `find_dependents`, `memory impact`),
deliberately coarse, landing as drafts like everything else, and shared through
the `sync` artifact rather than a server.
