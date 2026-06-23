# Principles

The architectural commitments behind memory. Read this before
proposing a feature that changes the data model or the trust loop —
several "obvious" upgrades have been considered and rejected, and the
reasoning is worth knowing before re-litigating.

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
  INC-411") — the code shows the choice, not the reasoning
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
lore by token — no persisted links needed. A persisted link layer
would be a *cache* of what the agent can re-derive, and caches need
maintenance (stale on rename, missing on new routes, dead on
deletion). Search-by-FTS plus a `repos: [...]` array already covers
the cross-repo discovery; the link layer is solving the wrong half
of the problem.

## 3. Agents suggest; humans approve

Agents can call `suggest_lore` and `report_conflict` — both land as
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
(`stats`), audit log, hook session markers — all live under
`~/.memory/`. The "telemetry" naming on
`MEMORY_NO_TELEMETRY=1` is historical; there is no outbound
telemetry to disable. See `docs/DATA-FLOW.md` for the diagram.

If you find yourself reaching for a network call, stop. The
trust posture is "your machine, your data, your audit log."

## 5. Feature surface is closed for v0.1

Things explicitly NOT in v0.1, with rationale:

- **Typed records / linksTo cross-repo edges.** ~~See principle 2 — the
  agent derives these. Revisit only when dogfooding produces concrete
  cross-repo pain, not as speculative architecture.~~ **Shipped
  (post-0.1.1) as the boundary map.** The concrete pain — "change a
  contract in app A, what does it break in B and C?" — was judged worth
  building to the end goal rather than waiting on dogfood. Boundaries
  are a *typed* record (`provides` / `consumes` edges over normalised
  contract names), deliberately coarse-grained (service/contract level,
  not an exhaustive call graph) to avoid the review-queue blow-up that
  fine-grained auto-derivation would cause. They keep the trust spine:
  agents `declare_boundary` → draft; a human ratifies. Cross-repo
  aggregation rides the existing `sync` artifact
  (`.memory/boundaries.jsonl`), not a server — principle 4 holds.
  See "Cross-repo impact map" in the README.
- **Server-side dedup of `suggest_lore` / `report_conflict`.**
  Reviewer triages duplicates in the existing review queue. Auto-dedup
  hides surface area we want the human to see.
- **Bidirectional `conflictsWith` back-references.** Would require
  the agent to mutate the original (canonical) record. Violates
  principle 3.
- **Auto-promotion of onboarding drafts.** The whole point of the queue
  is the human review beat.
- **Mechanical / CLI-driven cold-start (`induct`, `ingest-md`).**
  Removed post-0.2. A fixed-question interview produces generic records;
  chunking docs produces ~80% noise that floods the review queue. Good
  lore needs judgement about what's durable — the `/memory-onboard`
  skill (agent reads the repo, proposes grounded drafts) is the single
  cold-start path. One good door beats four mediocre ones.
- **Semantic / embedding search.** FTS5 + Crockford ids + manual
  tagging gets you most of the way. Embeddings are a v0.2+
  consideration if recall becomes measurably bad.
- **Web UI / server mode.** Single-user local CLI. The MCP server
  is stdio-only; no HTTP listener. This stays.

## 6. The next material upgrades (priority order)

Two near-term wins that DO move the needle, both small:

1. **Corpus growth — lower the friction of creating lore.** Today's
   dogfood reality is ~9 records after weeks of work; relationship
   layers don't matter when N is small. Options that scale lore
   creation without breaking the trust model:
   - Stop-hook variant that nudges "you did X, anything worth
     capturing?" at session end (the hook infrastructure exists).
   - Session-grounded `/memory-onboard` follow-ups: capture what the
     agent actually learned working in the repo this session, not just a
     cold first-touch survey.
   - Commit-message capture (`memory suggest --from-commit <sha>`)
     for the "I wrote this in the commit message, why not capture it"
     case. *(Shipped.)*

2. **Cross-repo discovery in the existing shape.** Two sub-items:
   - `memory sync pull <parent>` — recursive walk of every
     `.memory/` directory under a parent, run sync import on each.
     One command bootstraps a fresh machine across all the workspace
     trees the user works in.
   - Retrieval-rule update to teach agents about repo-context: when
     a search hit's `repos` doesn't include the current repo, treat
     as cross-repo guidance (not authority) and reason about
     applicability.

Both of these get implemented alongside this document. They earn
their keep against principle 2 (they help the agent USE lore, they
don't replace what the agent can derive).

## 7. When to revise this document

This file should change when:

- A principle is *demonstrated* wrong by real usage (not by argument).
- A deferred feature accumulates a real pain log that justifies it.
- A new architectural commitment is made and shouldn't be relitigated.

This file should NOT change when:

- A clever-sounding feature is proposed without empirical evidence.
- An external reviewer suggests a redesign without seeing the dogfood
  failure modes.
- Someone wants to add a "missing" feature that competes with what
  the agent natively does well.
