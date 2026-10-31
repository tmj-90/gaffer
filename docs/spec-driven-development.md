# Spec-Driven Development — build plan (shipped)

> **Status: shipped.** All three phases are on the main line: the `specs` object and
> `runner/bin/spec-author.mjs` (Phase 1), spec → decompose with clause provenance on
> acceptance criteria and frozen clauses seeded as lore (Phase 2), and the coverage read
> model (`GET /specs/:id/coverage`) with the Specs dashboard view (Phase 3). The
> spec-coverage DoD signal is wired but deliberately non-enforcing and off by default
> (`GAFFER_SPEC_COVERAGE_GATE`, `packages/dispatch/src/policy/specCoverageGate.ts`).
> Tests: `runner/test/spec-author.test.sh`, `decompose-spec.test.mjs`,
> `spec-freeze-seeds-lore.test.sh`, `e2e-spec-to-done.test.sh`. The plan below is kept
> as the design record.

A **spec** is AI-drafted from a brief, human-edited, **frozen**, then fed into the existing
`decompose` engine as one extra input. It never forks the pipeline — it sits in front of it.
Frozen clauses seed durable product-intent lore (which already reaches delivery agents via
`gaffer_product_context_block()` → `lg search --kind decision,requirement,non-goal`) and thread a
provenance id down to acceptance criteria (where traceability lives). The one-liner path stays
fully intact; the spec is the power path, never a toll booth.

## Locked decisions
1. Spec = **minimal first-class table** (`specs`), not artifact-on-session — Phase 3 needs stable `clause_id`s + a frozen snapshot.
2. Clause→AC link = **nullable `spec_clause_id TEXT` column** on `acceptance_criteria` (1-clause→N-ACs), ADD COLUMN migration (`connection.ts:230` pattern). Join table only if many-to-many later.
3. Authoring = **separate `runner/bin/spec-author.mjs`**, mirrors `decompose.mjs`; distinct artifact/freeze-gate/model call.
4. Freeze **auto-seeds clauses as lore, gated** (draft→approve unless `MEMORY_AUTO_APPROVE`), reusing `suggestLore`.

## Reuse (already at wave-two head — do NOT rebuild)
- `LoreKind = decision|requirement|non-goal|convention|gotcha|other` (`packages/memory/src/db/types.ts:34`, migration `009-lore-kind`)
- `suggest_lore` accepts `kind` (`server.ts:551`), gated draft→approve; `lg search --kind` filter
- `gaffer_product_context_block()` (`runner/lib/context-primer.sh:187`) injects `<untrusted-product-context>` "PRODUCT CONTEXT — why this work exists" into every delivery prompt
- `PRODUCT_INTENT_KINDS = {decision, requirement, non-goal}` (`packet.ts:120`); `distillTicketIntent` (close-time capture)
- The one real gap: **structured provenance** (lore links tickets as body prose only; ACs have no clause ref). That's the single schema addition traceability needs.

## Phase 1 — spec object + authoring helper (independently shippable)
brief → AI-drafted structured spec → human edits → freeze. No decompose changes yet.
**Dispatch (10-step first-class-object recipe):**
- Schema `CREATE TABLE specs` in `db/schema.ts` (`id, title, brief, clauses_json=[{clause_id, kind:requirement|non-goal|decision, text, rationale?}], status draft|frozen|superseded, target_repo/scope_node, timestamps`); bump `SCHEMA_VERSION`.
- `Spec`/`SpecClause` types (`domain/types.ts`); `createSpecInput` Zod (`domain/schemas.ts`); `specRepository.ts` (model `acRepository.ts`); `specsService.ts` (model `epicsService.ts`) with `createSpec/freezeSpec/getSpec`; facade `Dispatch.createSpec` (`core.ts`); REST `POST/GET /specs` + `/:id/freeze` (model `POST /epics:498`); MCP `create_spec` (`tools.ts:197`); CLI `spec` verb (`cli/index.ts:421`).
**Runner:** `runner/bin/spec-author.mjs` (clone `decompose.mjs`: stdin `{brief,history,context}`, `claude -p` on `GAFFER_PLAN_MODEL`, `quarantine()` the brief, emit `{phase:"clarify",questions}` or `{phase:"spec",spec:{clauses}}`; PlanBuildRunner-style spawn boundary + byte caps + token strip). `runner/skills/spec-author/SKILL.md` (authoring prompt: one clause = one testable statement).
**Web:** extend Plan-a-build panel (`app.js:7007`) with a spec step rendering draft clauses editably (reuse `renderPlanProposal`) + a Freeze button. No new view yet.
**Tests:** vitest unit (specsService create/freeze/immutability, clause-kind validation, Zod edges, repo round-trip); behavioral `spec-author.test.sh` (real helper vs stub claude — clarify→spec, quarantine of malicious brief, forcePlan/max-turns, negative control); e2e `e2e-spec-author.test.sh` (brief→clarify→spec→freeze→immutable, temp DB).

## Phase 2 — spec → decompose → traceable epic (the value unlock)
- Inject spec: optional `spec` field on decompose request — `planBuildBody` (`schemas.ts:501`), PlanBuildRunner (already spreads optional fields, `planBuild.ts:170`), `decompose.mjs` `readRequest`+`buildPrompt` render a new quarantined SPEC block beside the brownfield block (`decompose.mjs:525`). When `spec` present, default `forcePlan` (overridable). Output/`validateResult` unchanged so `create_epic` untouched — **except** the planner emits optional `clauseRef` on each AC.
- Provenance: `acceptance_criteria` add nullable `spec_clause_id TEXT` (ADD COLUMN); plumb `addAcInput` (`schemas.ts:61`), `addAcceptanceCriterion` (`ticketService.ts:170`), `epicTicketInput`/`epicsService.createEpic` (`epicsService.ts:100`). Lore: structured `spec_id/clause_id` linkage (memory migration `010` or `lore_links` side table) through `suggestLore` + `suggest_lore` schema (`server.ts:551`).
- On `freezeSpec` (or create_epic-from-spec): seed each clause as a draft lore record with its kind + linkage via `suggestLore`. Primer already pulls those kinds → reaches delivery agents with **zero primer changes** (the payoff).
- Tests: decompose behavioral (spec input → ACs carry `clauseRef`s covering requirements; negative control drops a clause → coverage assertion fails); unit (AC persists `spec_clause_id`; suggestLore stores linkage; freeze seeds 1 lore draft/clause, correct kind); integration (freeze→decompose→create_epic → ACs carry clause ids + linked lore drafts); runner behavioral (delivery tick primes PRODUCT CONTEXT with seeded clauses — extend `product-context-block.test.sh`).

## Phase 3 — coverage & traceability (the differentiator)
- Coverage read model + `GET /specs/:id/coverage`: per clause → which ACs reference it, satisfied vs open, clauses with no covering ticket (gap report). Model on the wave-two `reworkAttemptRepository` SQL-side ranking.
- New specs dashboard view (`VIEWS`/nav `app.js:535`, `renderSpecs` on `renderEpics`) — trace + coverage gaps; link spec→epic via epic scope-node id.
- Bounce trace: join rework/failure trail to clause via AC provenance ("requirement X bounced 3×").
- Flag-only (don't build): spec-coverage as a DoD signal (clause with no satisfied AC blocks epic completion), gated off by default.
- Tests: unit (coverage read model: fully/partial/orphan-clause/orphan-ticket; SQL aggregation); e2e `e2e-spec-to-done.test.sh` (brief→spec→freeze→epic→deliver 1 ticket via stub agent→AC satisfied→clause green; rejected delivery→clause open; negative control: no-ticket clause in gap report).

## Cross-cutting (mirror AUTOMATION_TESTING_PLAN.md exactly)
Layers/phase: vitest unit (all TS) · runner behavioral (`.test.sh`/`.test.mjs` driving real binaries vs stub claude + temp DB + real git) · E2E extension · coverage-floor gate auto-applies to new dispatch/memory code. Conventions: behavioral-over-grep, a **negative control in every suite**, hermetic `mktemp -d` + `trap EXIT`, `SKIP (exit 0)` when CLI unbuilt, per-test wall-clock cap. Safety: spec+clause text are untrusted → ride the existing `<untrusted-*>` quarantine in decompose + `<untrusted-product-context>` in primer → **no safety-hook change** (no parity-test churn); add one behavioral test that a prompt-injection payload in a clause stays quarantined through freeze→decompose→primer.

## Build order for the loop
Phase 1 (dispatch object → runner helper → web → tests) → Phase 2 (inject + provenance + seed + tests) → Phase 3 (coverage + view + tests). Commit per verified unit. Same branch per operator instruction (plan originally suggested separate PRs after #26; overridden).
