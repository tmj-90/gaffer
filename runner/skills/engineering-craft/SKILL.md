---
name: engineering-craft
description: Use on every code delivery to hold the structural-quality bar — reusability where repetition is real, clear boundaries, explicit error handling, focused units, honest names, and tests for real logic. Invoke whenever you implement a claimed ticket and want the change to read like production code the repo's maintainers would approve, not a quick hack that merely passes. A cross-cutting lens that composes with `minimalism` (least code) and whatever build skill the ticket needs. For "make this reusable / well-structured", "production quality", "don't leave a hack".
stack: []
area: quality
---

# Engineering craft — code the maintainers would approve

The counterpart to `minimalism`. Minimalism asks *"is this the least code that works?"*;
craft asks *"is the code that remains well-structured, honest, and safe to change?"* The
target is the intersection: the **smallest change that a careful reviewer would approve
without asking you to redo it**. This is a lens, not a stage — apply it while you
implement, and confirm it in `self-review` before submitting.

Craft is never a licence to add code. When craft and minimalism seem to disagree, they
don't: the rule below (real repetition, not speculative) resolves it every time.

## The craft bar (hold all of these)

1. **Reuse only real repetition — never speculative abstraction.** DRY applies to
   duplication that *already exists* (the same logic in two places you can see). Do NOT
   introduce a base class, generic, config system, or "flexible" helper for a second
   caller that doesn't exist yet — that's the over-engineering `minimalism` forbids.
   Rule of thumb: extract on the *third* occurrence, inline the first two. When you do
   extract, give the shared unit one clear responsibility.
2. **Boundaries at the edges.** Keep transport (HTTP/CLI), business logic, and
   persistence (DB/filesystem) separable — don't put a SQL query or a `fetch` in the
   middle of domain logic. Depend on the seam the repo already uses; don't invent a new
   layering the codebase doesn't have.
3. **Handle errors explicitly — no silent failures.** No empty catch blocks, no
   swallowed rejections, no ignored return codes. Either handle the error meaningfully or
   propagate it with context. A user-facing surface gets a clear message; a server path
   logs the detail. Never `catch {}` to make a test pass.
4. **Validate at the boundary.** Untrusted input (request bodies, CLI args, external API
   responses, file contents) is checked before use — fail fast with a clear message. Use
   the repo's existing validation approach (e.g. schema/zod) rather than ad-hoc checks if
   one exists.
5. **Small, focused units.** A function does one thing (aim < ~50 lines); a file stays
   cohesive. If a function has grown a second responsibility or four levels of nesting,
   split it or use early returns — but only when it genuinely helps clarity, not to hit a
   number.
6. **Honest names.** Names say what the thing is/does. Booleans read as `is/has/should/can`.
   No `data2`, `tmp`, `helper`, `doStuff`. A good name removes the need for a comment.
7. **Don't mutate what you don't own.** Prefer returning new values over mutating shared
   inputs/state; treat function arguments as read-only unless mutation is the point.
   Respect the language's idiom — this is immutability *where idiomatic* (a Go pointer
   receiver or an in-place sort in hot code is fine); it is not a mandate to copy
   everything.
8. **Composition over inheritance.** Reach for a function, a small object, or a passed-in
   dependency before a class hierarchy.
9. **Tests are part of the change.** Cover the real logic you added — happy path, the
   boundaries, and the error cases — not just the line that's easiest to assert. Test
   code is a guarantee, not bloat (`minimalism` agrees). Use `add-unit-test` /
   `add-integration-test` for the mechanics.
10. **Match the repo, don't reform it.** Follow the prevailing conventions, patterns, and
    style of the code around you. Craft means your addition is indistinguishable from
    well-written existing code — not that you impose a cleaner paradigm the repo doesn't
    use. A repo-wide refactor is a separate ticket.

## How it composes

- **With `minimalism`:** same goal from two sides — least code *and* well-structured.
  If you're tempted to add structure "for later", minimalism wins (rule 1). If you're
  tempted to save lines by swallowing an error or skipping validation, craft wins (rules
  3–4): those are guarantees, not bloat.
- **With the build skills** (`backend-service`, `add-api-endpoint`, `frontend-component`,
  …): those tell you *what* to build for the domain; craft is *how well* you build it.
  On frontend work, `frontend-foundations` adds the surface-specific bar (design quality,
  accessibility, tokens).
- **With `self-review`:** before submitting, re-read your diff against this bar. A change
  that trips rules 1, 3, or 5 is the kind a reviewer sends back.

## Marker

When you make a non-obvious structural call — extracted a shared unit, chose a boundary,
declined an abstraction, added validation at a specific edge — record it in one line so
the choice is visible: use `request_decision` at `log_only`, or note it in the evidence
you record via `record-evidence`. This keeps the craft decision auditable (and lets the
factory see the skill was applied). One line, only for real calls — not a running
commentary.
