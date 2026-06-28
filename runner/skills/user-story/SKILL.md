---
name: user-story
description: Use when generating user stories with acceptance criteria, or planning sprint capacity against a set of stories. Triggers on "write user stories", "create stories for this feature", "break this into stories", "sprint planning", or "story points".
stack: []
area: product
---

# Generate structured user stories with acceptance criteria

A user story is not a task list — it's a unit of user value that can be independently delivered and tested.

## Story format

```
As a [specific user role],
I want to [action / capability]
so that [outcome / value].

Acceptance criteria:
- Given [context], when [action], then [observable outcome].
- Given [context], when [error condition], then [error handling].
```

**Anti-patterns to reject:**
- "As a user" (too vague — which user?)
- Stories without AC ("it should work")
- Stories that describe implementation ("add a button") instead of value ("so that I can...")
- Stories > 8 story points (split them)

## Story sizing heuristic (Fibonacci)

| Points | Scope |
|--------|-------|
| 1 | Trivial — confident implementation; no unknowns |
| 2 | Small — clear implementation; minor unknowns |
| 3 | Medium — clear approach; some complexity |
| 5 | Large — approach known; meaningful unknowns or cross-cutting |
| 8 | Extra large — approach uncertain; split if possible |
| 13+ | Epic — must be split before sprint planning |

## INVEST principles (every story should satisfy all six)

- **Independent** — can be delivered without depending on another in-progress story.
- **Negotiable** — the how is open; the what and why are fixed.
- **Valuable** — delivers value to a real user, not just to engineering.
- **Estimable** — the team can size it; unknowns are identified.
- **Small** — fits in a sprint; ≤ 8 points.
- **Testable** — ACs allow a tester to confirm done from not-done.

## Sprint planning

Given a capacity (in story points) and a prioritised backlog:
1. Sort stories by priority (impact × confidence / effort).
2. Take from the top until capacity is consumed.
3. Flag any story ≥ 8 points — must be split before it enters the sprint.
4. Confirm each story in the sprint satisfies INVEST.

## Steps

1. **Gather context.** Feature or epic description; user personas available; any existing requirements or PRD.
2. **Identify the user roles** involved. For each distinct role, generate stories independently.
3. **Write stories in standard format.** One value unit per story; INVEST check for each.
4. **Write at least two ACs per story.** Happy path + at least one error/edge case.
5. **Size each story.** Flag 8+ for splitting.
6. **For sprint planning** — sort by priority; fill to capacity; confirm no 13+ point stories in the sprint.

## Review checklist

- **Specific user role** — not "user" or "admin" (if there's only one admin role, "admin" is specific enough).
- **Value stated explicitly** — the "so that" is not "I can do X" but "I get [outcome]".
- **ACs are testable** — Given/When/Then format; observable outcomes.
- **No story > 8 points** without a split plan.
- **INVEST satisfied** — all six principles met for each story.

## Rules

- A story without testable ACs cannot enter a sprint.
- Stories describe value, not implementation — if the "I want" clause describes code, rewrite it.
- Split at 8 points: a story that can't be done in a sprint is a planning risk.
