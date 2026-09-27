---
name: write-adr
description: Use when a ticket, plan, or delivery involves a decision with lasting consequences — a library choice, a data model, a boundary between services, a protocol, a deliberate trade-off — and it must be recorded as an Architecture Decision Record others can find and challenge. Invoke for "write an ADR", "document why we chose X", when a decision is escalated via request_decision and resolved, or when you find yourself explaining a non-obvious choice in a commit message.
stack: []
area: docs
---

# Write an Architecture Decision Record

An ADR records one decision: the context that forced it, the options that were live, the
choice, and what it costs. Its value is that a future reader can see why, judge whether
the reasons still hold, and supersede it deliberately instead of by accident. Keep it
short, dated, and immutable once accepted.

## Steps

1. **Find the repo's ADR convention.** Look for `docs/adr/`, `docs/decisions/`,
   `architecture/decisions`, or an existing numbered `NNNN-title.md` series. Match its
   template and numbering. If there is none, create `docs/adr/0001-record-architecture-decisions.md`
   describing the convention, then your decision as `0002-...`. Check `search_lore` for
   decisions already captured as lore so you neither duplicate nor contradict them.
2. **State the decision in one sentence** in the title, in the imperative
   ("Use SQLite as the control-plane store"). If you cannot, you have two decisions;
   write two ADRs.
3. **Write the context honestly.** The forces at play: requirements, constraints,
   deadlines, the thing that hurt. Enough that a reader in a year understands why the
   question came up. No marketing.
4. **List the options actually considered**, each with the concrete reason it lost.
   "Considered Postgres; rejected because the factory must run with zero services on a
   laptop" is useful; "considered alternatives" is not.
5. **Record the decision and its consequences**: what becomes easier, what becomes
   harder, what is now forbidden, what would make you revisit it. Consequences are the
   most valuable section and the one most often skipped.
6. **Set the status**: Proposed, Accepted, Deprecated, or Superseded by NNNN. An
   accepted ADR is never edited except to change its status; a new decision gets a new
   ADR that links back.
7. **Link both ways.** Reference the ADR from the code or doc it governs (a comment at
   the module boundary, a line in the README section) so it is found from where the
   decision bites.
8. **Mirror the decision into memory.** Call `suggest_lore` with kind `decision`
   summarising the choice and its reason, citing the ADR path, so agents that never
   open `docs/` still see it in `search_lore`. Evidence the file with the
   `record-evidence` skill.

## Rules

- One decision per ADR; one sentence title; dated and numbered.
- Options are the ones really weighed, each with its rejection reason.
- Consequences section is mandatory and names what gets harder.
- Accepted ADRs are immutable; supersede, do not rewrite history.
- Every ADR is mirrored as `decision` lore; every lore decision of lasting weight should
  have an ADR.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While writing the record you make a lasting decision explicit — the options weighed and why one won — which is exactly the knowledge later agents need before they contradict it.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
