---
name: add-feature-flag
description: Use when a ticket asks to ship behaviour behind a toggle — a gradual rollout, a kill switch, an A/B variant, a dark launch — or to add, wire, or clean up a feature flag with a default, an owner, and a removal plan. Invoke for "put it behind a flag", "add a kill switch", "roll out to 10%", or "remove the flag now that it's fully on".
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: workflow
---

# Add a feature flag

A flag decouples deploy from release: the code ships dark, is switched on deliberately,
and can be switched off in seconds. Every flag is also debt with an expiry date. Add it
so both paths are tested, the default is safe, and its removal is already planned.

## Steps

1. **Find the repo's flag mechanism.** A flags service SDK, a config-driven module, env
   vars, a settings table. Use it; do not add a second system. Call `search_lore` for
   naming conventions and where flags are declared. If the repo has none and the ticket
   needs one, propose the smallest (a typed config module with defaults) via
   `request_decision` before building infrastructure.
2. **Name and type it.** A descriptive, namespaced name (`checkout.new-address-form`),
   a boolean unless the ticket needs variants, a documented default. The default is the
   SAFE state — the old behaviour — so an unset flag never surprises production.
3. **Declare once, read at one boundary.** Register the flag in the repo's declaration
   point with its owner, purpose, and intended removal date. Evaluate it at the edge of
   the feature (the route, the component, the job entry) and pass the decision down;
   sprinkling `isEnabled()` calls through the call stack makes removal a hunt.
4. **Keep both paths correct.** The new path and the old path must both work, both be
   tested, and never share a half-migrated state. Run the suite with the flag off and
   with it on (a test parameter or two test cases), and assert the default explicitly.
5. **Make the decision observable.** Log or tag the flag state where the behaviour
   diverges (a structured field, a metric label) so an incident can be tied to a
   rollout; never log user data with it.
6. **Plan the removal in the same change.** A removal ticket, the date in the flag's
   declaration, and a note in the evidence. A flag that is 100% on for a month is dead
   code wearing a disguise; the `deprecate-and-remove` skill retires it.
7. **Evidence** with the `record-evidence` skill: the flag name, default, owner,
   removal date, and the test output for both states.

## Rules

- One flag system per repo; use the existing one.
- Default is the old, safe behaviour; the flag turns the new thing ON.
- Evaluate at one boundary; do not scatter checks.
- Both paths tested in the same suite run; the default asserted.
- Every flag has an owner and a removal date recorded where it is declared.
- Flags never gate security controls off (a flag may add a check, never remove one).
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While wiring the flag you learn where flags are declared, how they are named, and how rollouts are actually done here.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
