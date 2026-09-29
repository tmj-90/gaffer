---
name: write-adr
description: Use when a ticket, plan, or delivery involves a decision with lasting consequences — a library choice, a data model, a boundary between services, a protocol, a deliberate trade-off — and it must be recorded as an Architecture Decision Record others can find and challenge. Invoke for "write an ADR", "document why we chose X", when a decision is escalated via request_decision and resolved, or when you find yourself explaining a non-obvious choice in a commit message.
stack: []
area: docs
---

# Write an Architecture Decision Record

An ADR records one architecturally significant decision in Michael Nygard's format — Title,
Status, Context, Decision, Consequences — so a future reader can see why, judge whether the
reasons still hold, and supersede it deliberately. Keep it to one or two pages, dated,
numbered, and immutable once accepted.

## Template

```markdown
# NNNN. <Imperative decision, e.g. "Use SQLite as the control-plane store">

Date: YYYY-MM-DD
Status: Proposed | Accepted | Rejected | Deprecated | Superseded by [NNNN](NNNN-slug.md)

## Context
The forces: requirements, constraints, what hurt, what is uncertain. Facts, not advocacy.

## Options considered
- **<Option A>** — why it lost, concretely.
- **<Option B>** — why it lost.

## Decision
We will <do X>. <Scope: where it applies and where it does not.>

## Consequences
Easier: … Harder: … Now forbidden: … Revisit if: <measurable trigger>.
```

"Options considered" extends Nygard's format; keep it unless the repo's template
omits it.

## Procedure

When you cannot write files (planning and spec roles), do not draft the file: put the
decision and its options in your output instead, as a ticket or acceptance criterion in
a plan or a `decision` clause in a spec, so a delivery ticket writes the ADR.

1. **Find the convention.** Look for `docs/adr/`, `docs/decisions/`, `doc/adr/`,
   `architecture/decisions`, or a numbered `NNNN-title.md` series; match its template,
   numbering, and status vocabulary. If none exists, create
   `docs/adr/0001-record-architecture-decisions.md` (the convention itself) and write yours
   as `0002-…`. Numbers are sequential and never reused. `search_lore` for decisions
   already recorded so you neither duplicate nor silently contradict one.
2. **One decision, one sentence.** The title is the decision in the imperative. If you need
   "and", write two ADRs.
3. **Context honestly.** Enough that a reader in a year understands why the question arose:
   the requirement, constraint or incident that forced it, with links to the ticket or
   spec. Include the non-functional forces that actually mattered (consistency under
   concurrent writers, durability of acknowledged writes, operability, cost).
4. **Options actually weighed**, each with the concrete reason it lost. "Considered
   Postgres; rejected because the factory must run with zero services on a laptop" is
   useful; "considered alternatives" is not. Include "do nothing" when it was viable.
5. **Decision in active voice** ("We will…"), with its scope.
6. **Consequences — all of them.** What becomes easier, what becomes harder, what is now
   forbidden, new risks and how they are mitigated, and a measurable revisit trigger. This
   is the most valuable section and the most often skipped.
7. **Set status truthfully.** An agent-made choice within the ticket's authority may be
   `Accepted` and is flagged with `request_decision` at `log_only`/`agent_can_choose`. A
   product, architecture or security call you cannot make is `Proposed` and escalated with
   `request_decision` as `human_required`; do not mark it accepted yourself. To change an
   accepted decision, write a new ADR that says "Supersedes NNNN" and change only the old
   one's status line to "Superseded by …".
8. **Link both ways.** Reference the ADR from where the decision bites (module header
   comment, README section, config file) and from the ADR index if the repo keeps one.
9. **Mirror into memory and evidence.** Call `suggest_lore` with kind `decision`
   summarising the choice and reason, citing the ADR path in the body (the `source`
   field takes only a URL). Evidence the file with the `record-evidence` skill, then
   stop.

## Done when

- The file is in the repo's ADR directory with the next free number, the date, and a status.
- Context, options (each with its rejection reason), decision and consequences (including
  what gets harder and a revisit trigger) are present.
- Links exist from the governed code/doc to the ADR; a superseded ADR's status is updated.
- Formatting passes the repo's markdown check if configured (e.g. `npx --no -- prettier --check`).

## Review checklist (concrete defects only)

- More than one decision in one record, or a title that is a topic, not a decision.
- An option listed without why it lost; consequences with no downside.
- An accepted ADR's body edited instead of superseded; a reused number.
- `Accepted` status on a decision that needed human sign-off.
- The ADR contradicts an existing ADR or lore decision without superseding it.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While writing the record you make a lasting decision explicit — the options weighed and why one won — which is exactly the knowledge later agents need before they contradict it.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
