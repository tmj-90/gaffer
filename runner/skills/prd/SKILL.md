---
name: prd
description: Use when writing a Product Requirements Document — to define what to build and why, with evidence-gated drafting. Refuses to draft without a real problem, user, and metric. Triggers on "write a PRD", "product requirements", "spec for this feature", "what should we build for X", or "requirements document".
stack: []
area: product
---

# Write evidence-gated product requirements

Without a real problem, a specific user and a measurable metric, a PRD is only a feature
wish. Without explicit quality requirements it is also a trap. Live factory runs showed
that a brief's "must never be corrupted" became one mechanism in the plan, and concurrent
writers shipped broken twice. A PRD states **outcomes and guarantees**. It leaves
solutions to the engineers (Cagan, *Inspired*: product teams are given problems to solve,
not features to build).

## Forcing questions

1. **Problem.** What user problem does this solve, and what is the evidence? Examples:
   support tickets, interview quotes, funnel data. "The CEO wants it" is not evidence.
2. **User.** Who has the problem? Give the segment, role and how often it hurts.
   "Everyone" is not a user.
3. **Metric.** What single number moves if this works? By how much, measured where, and
   by when?
4. **Alternatives.** What do these users do today, and why is that not enough?
5. **Non-goals.** Which adjacent asks are out of scope for v1?
6. **Quality bar.** Which of these matter, and at what level?
   - data durability across a restart or a crash mid-write
   - concurrent users or processes writing the same data
   - error behaviour
   - supported runtimes, browsers and OSes
   - security and privacy
   - performance under a stated load

In a conversation, ask these one at a time. **Unattended (a factory agent)**, never wait.
Take the answers from the ticket, the brief, the lore (`search_lore`) and the repo. List
whatever is still unknown under Open questions. In the factory's clarify pass, raise an
unknown that blocks delivery with `request_decision` as the `clarify` skill describes;
never `mark_ticket_blocked` (it is refused without a claim).

## Drafting gate

**Do not draft** if Q1, Q2 or Q3 is unknown, circular, or "we'll figure it out". Output the
open questions instead, each with the cheapest way to answer it: five problem interviews, a
funnel query, a fake-door test, or a one-day prototype. See the `product-discovery` skill.

## Required sections

- [ ] **Problem statement**, with the evidence from Q1.
- [ ] **Target user and segment**, including who is explicitly NOT the target.
- [ ] **Goals and non-goals**.
- [ ] **User stories with acceptance criteria.** One story per unit of user value (INVEST,
      see the `user-story` skill). Each has at least one happy-path AC and at least one
      error or edge AC.
- [ ] **Quality requirements.** Each is a testable statement with a concrete load or
      schedule. State the guarantee, never the mechanism:
  - _Persistence:_ an acknowledged write survives a restart, and a write killed mid-way
    leaves the prior data readable.
  - _Concurrency:_ N concurrent writes through every entry point all succeed and none are
    lost. This also holds across processes, and when a lock holder pauses, if more than
    one process can write.
  - _Failure behaviour:_ documented errors, no crash, and no state change on invalid
    input.
  - _Runtime support:_ the pinned versions are the ones tested.
  - _Security:_ authn/authz rules, cross-user isolation, no secrets in logs.
  - _Performance:_ a threshold under a stated load, only if speed matters.

  If a quality does not apply, say so and give the reason.
- [ ] **Success metric**, with a threshold, a measurement source and a review date.
- [ ] **Open questions**, each with an owner and the cheapest way to resolve it.
- [ ] **Out of scope**, as an explicit list.

## Acceptance criteria format

```
Given [precondition/state]
When  [one action, with concrete data or load]
Then  [observable outcome: response, stored state, message]
```

Each AC is one behaviour. A tester must be able to automate it without asking the PM.
"Works correctly", "is robust" and "handles errors" are not ACs.

## Steps

1. **Collect answers** to the forcing questions, interactively or from the ticket, brief,
   lore and repo.
2. **Apply the drafting gate.** If it blocks, output the open questions and their
   cheapest resolution, then stop.
3. **Draft every required section.** Derive the quality requirements from the product
   shape as well as from the words in the brief. A server with a store implies
   concurrent writers. Two binaries sharing data implies cross-process writers.
4. **Trace.** Every goal maps to at least one story. Every quality requirement is a
   testable AC or a stated "not applicable".
5. **Emit the completion checklist** at the end. Mark each section done, or name what
   is missing.

## Review checklist

- The problem has evidence, not opinion.
- The user is a specific segment and role.
- There is one metric, with a threshold, a source and a date.
- Every AC is a Given/When/Then a test can automate, and it covers errors as well as the
  happy path.
- Quality requirements are explicit and measurable, with no mechanism standing in for a
  guarantee.
- Non-goals and out-of-scope items are listed, not implied.
- Open questions have owners.

## Rules

- One success metric per PRD. Guardrail metrics (e.g. error rate) may accompany it.
- Describe the problem and the guarantees. Do not dictate the implementation.
- Never invent evidence, users or numbers. Mark an unknown as unknown.
