---
name: user-story
description: Use when generating user stories with acceptance criteria, or planning sprint capacity against a set of stories. Triggers on "write user stories", "create stories for this feature", "break this into stories", "sprint planning", or "story points".
stack: []
area: product
---

# Write user stories with testable acceptance criteria

A user story is a unit of user value that can be delivered and tested on its own. It is
not a task. Its acceptance criteria (ACs) are the contract: in the factory, the delivery
agent builds to them, the reviewer checks that **each AC has a test exercising that AC's
own behaviour**, and the independent tester verifies them black-box. An AC that no test
can check will be approved unverified. A behaviour with no AC will not be built.

## Story format

```
As a <specific role>, I want <capability> so that <outcome/value>.

Acceptance criteria (Gherkin):
Scenario: <one behaviour>
  Given <state/precondition, with concrete data>
  When  <one action>
  Then  <observable outcome>
```

Gherkin rules (from the Cucumber reference):

- One behaviour per scenario, and one `When` per scenario.
- Write declaratively: "When she submits a valid order", not "When she clicks #btn-3".
- A `Then` names something observable: a response, a stored state, a displayed message,
  an exit code. "It works" is not observable.
- Use `Scenario Outline` with `Examples` for the same rule over several data rows
  (boundaries, invalid inputs).

## INVEST (Bill Wake, 2003)

Every story should be:

- **Independent**: deliverable in any order, without waiting on another in-flight
  story.
- **Negotiable**: the what and why are fixed; the how is open.
- **Valuable**: a user or customer gets something, not only engineering.
- **Estimable**: the team can size it, and unknowns are named (or spiked).
- **Small**: fits in a sprint. In the factory, one agent delivers it in one ticket.
- **Testable**: every AC can be checked by an automated test.

## Cover more than the happy path

Every story needs at least:

1. One **happy-path** scenario.
2. One **error or edge** scenario: invalid input, empty state, a boundary, a missing
   permission.
3. The **quality scenarios its shape implies**. These are the ones live builds shipped
   broken when nobody wrote them down:
   - **Stores data:** an acknowledged save survives a restart, and a save interrupted
     mid-write leaves the prior data intact.
   - **Several users, requests or processes write:** e.g. "Given 20 clients save at
     once, then all 20 saves succeed and all 20 records exist." When more than one
     process writes, cover a writer that is paused or killed while holding a lock.
   - **Behind auth:** a user cannot read or change another user's data.
   - **Speed matters:** a measurable threshold under a stated load.

## Splitting stories that are too big (SPIDR, Mike Cohn)

Split by one of these, then re-check INVEST:

- **Paths:** the happy path first, alternatives later.
- **Interfaces:** API first, then UI; or one platform at a time.
- **Data:** one data type or format at a time.
- **Rules:** simple business rules first, then complex ones.
- **Spike:** a timeboxed investigation when the unknowns block estimation.

Never split by layer ("backend story", "frontend story"): neither half is valuable alone.

## Steps

1. **Gather context**: the feature, epic, PRD or brief; the personas; the lore
   (`search_lore`); and the relevant code.
2. **Name the roles**, e.g. "billing admin" or "guest shopper". Write stories per role.
3. **Draft each story** in the format above, with one value unit per story.
4. **Write the ACs as Gherkin scenarios**: happy path, error/edge, and implied quality.
   Use concrete values.
5. **INVEST-check each story.** Split with SPIDR where it fails Small or Independent.
6. **Size it** (sprint planning only). Use Fibonacci points, where 1–3 means clear, 5
   means real unknowns, and 8 means split if you can. A 13+ is an epic that must be
   split. Fill the sprint from the top of the prioritised list until capacity is
   reached.
7. **Map each AC to a test.** Name the test level (unit, integration, e2e) that would
   prove each AC. If you cannot name one, rewrite the AC.

## Done when

- Every story names a specific role and the value in its "so that".
- Every story has a happy-path, an error/edge, and the implied quality scenarios, all
  in Given/When/Then with concrete data.
- Every AC maps to a nameable test.
- No story in the sprint is larger than 8 points. Larger stories carry a split plan.

## Anti-patterns

- "As a user…" when there are several distinct roles.
- An "I want" that describes code ("add a button", "create a table") instead of a
  capability.
- ACs that restate the story, or say "should work", "is robust" or "handles errors".
- A mechanism in place of a guarantee. "Uses atomic rename" is a design note. The AC is
  "an interrupted save leaves prior data readable".
- Technical-layer stories with no standalone value.
