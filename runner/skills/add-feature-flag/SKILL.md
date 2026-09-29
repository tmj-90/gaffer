---
name: add-feature-flag
description: Use when a ticket asks to ship behaviour behind a toggle — a gradual rollout, a kill switch, an A/B variant, a dark launch — or to add, wire, or clean up a feature flag with a default, an owner, and a removal plan. Invoke for "put it behind a flag", "add a kill switch", "roll out to 10%", or "remove the flag now that it's fully on".
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: workflow
---

# Add a feature flag

A flag decouples deploy from release: code ships dark, is switched on deliberately, and
can be switched off in seconds. Every flag is also a branch in the code that someone must
test and later delete. Add it so both paths are correct, the default is safe, and its
removal is already planned.

## Steps

1. **Classify the flag** (Pete Hodgson, "Feature Toggles"); the category sets its
   lifetime and how dynamic it must be:
   - **release** — hides unfinished or unreleased work; lives days to weeks; usually a
     static per-deploy value. The common case.
   - **ops / kill switch** — lets operators turn off a costly or risky path under load;
     may live long; must be changeable at runtime without a deploy.
   - **experiment** — A/B cohorts; decided per request/user; needs consistent bucketing.
   - **permission** — per-user or per-plan access; long-lived; this is product logic, so
     treat it as an entitlement, not a temporary flag.
2. **Use the repo's flag mechanism.** A flags-service SDK, a config-driven module, env
   vars, a settings table. Call `search_lore` for naming and where flags are declared. If
   there is none, propose the smallest one (a typed config module with defaults, see the
   `add-config-option` skill) via `request_decision` before building infrastructure.
3. **Name, type and default it.** A descriptive, namespaced name
   (`checkout.new-address-form`), boolean unless variants are required. Never reuse a
   retired flag's name: old code still reading it will wake up. The default is the SAFE
   state — the current behaviour — and it is also what the code does when the flag
   source is unreachable or the value is malformed.
4. **Declare once; decide at one point.** Register the flag with owner, purpose, category
   and removal date. Evaluate it at the edge of the feature (the route, the component, the
   job entry) through one router function, and pass the decision (or the chosen
   implementation) inward. Scattered `isEnabled()` calls deep in the call stack make both
   testing and removal a hunt.
5. **Keep both paths correct.** Old and new paths must never share half-migrated state:
   if the new path writes a new data shape, the old path must still read it, or the
   rollout needs an expand/contract migration (the `add-db-migration` skill). A flag may
   ADD a security check; it must never switch one off.
6. **Test the combinations that ship.** Run the affected tests with the flag OFF (today's
   production) and ON (the intended release), plus an explicit test that an unset or
   unreadable flag yields the default. You do not need every combination of every flag —
   test the configurations you will actually run.
7. **Make the decision observable.** Record the flag state where behaviour diverges (a
   structured log field or metric label) so an incident can be tied to a rollout; never
   log user data alongside it.
8. **Plan the removal now.** The removal date in the declaration, a note in the evidence,
   and a follow-up the human can file. A flag that has been 100% on for weeks is dead code;
   the `deprecate-and-remove` skill retires it (delete the flag, the losing path and its
   tests together).

## Done when

The flag has one declaration with owner, category and removal date; the default equals
current behaviour and is asserted by a test; tests pass with the flag off and on; the
decision is made at one point; evidence (via the `record-evidence` skill) lists name,
default, owner, removal date and both test runs. On a resume that call is refused: do
not retry; put this, the AC → test map and the smallest-change note in your final
message.

## Stop and escalate when

- The ticket needs percentage rollout, targeting or runtime changes that the repo's
  mechanism cannot do: `request_decision` rather than building a flag service.
- The two paths cannot coexist without a data migration the ticket did not mention:
  `request_decision` with the migration it would need.

## Rules

- One flag system per repo; use the existing one.
- Default = old, safe behaviour, also on evaluation failure.
- Decide at one boundary; no scattered checks; never reuse a flag name.
- Both shipping configurations tested in the same run.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While wiring the flag you learn where flags are declared, how they are named, and how rollouts are actually done here.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
