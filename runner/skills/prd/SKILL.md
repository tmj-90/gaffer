---
name: prd
description: Use when writing a Product Requirements Document — to define what to build and why, with evidence-gated drafting. Refuses to draft without a real problem, user, and metric. Triggers on "write a PRD", "product requirements", "spec for this feature", "what should we build for X", or "requirements document".
stack: []
area: product
---

# Write evidence-gated product requirements

A PRD without a real problem, a specific user, and a measurable metric is a feature wish. Refuse to draft until those three are answered.

## Forcing questions (walk one at a time — do not batch)

1. **Problem** — What user problem does this solve, and how do you know it exists? (Support tickets, interview quotes, funnel data — "the CEO wants it" is not evidence.)
2. **User** — Who specifically has this problem? (Segment, role, frequency of pain. "Everyone" is not a user.)
3. **Metric** — What single number moves if this works, by how much, measured where?
4. **Alternatives** — What do these users do today instead? Why is that not enough?
5. **Non-goals** — What adjacent asks are explicitly out of scope for v1?

## Drafting gate

**Refuse to draft if Q1 (problem), Q2 (user), or Q3 (metric) is unknown, circular, or "we'll figure it out."**

Instead: output the open questions and the cheapest way to answer each (5 customer interviews, a funnel query, a fake-door test, a 1-day prototype). A week of discovery is cheaper than shipping the wrong feature.

## Required sections (every PRD must have all of these)

- [ ] **Problem statement** — with the evidence from Q1.
- [ ] **Target user and segment** — from Q2; who is explicitly NOT the target.
- [ ] **Goals and explicit non-goals** — from Q5.
- [ ] **User stories with acceptance criteria** — "As a [user], I want [action] so that [outcome]. Done when [testable condition]."
- [ ] **Success metric + threshold + measurement source** — from Q3; how and when you'll measure.
- [ ] **Open questions** — unresolved assumptions that need an answer before or during build.
- [ ] **Out of scope** — explicit list; protects from scope creep in delivery.

## Acceptance criteria format

```
Given [context / precondition]
When [action]
Then [observable outcome]
```

Every user story has at least one AC. ACs are testable — a QA engineer can verify them without asking questions.

## Steps

1. **Ask the forcing questions** one at a time. Wait for answers. Don't proceed if answers to Q1–3 are vague.
2. **Apply the drafting gate.** If blocked, output the open questions + cheapest resolution path.
3. **Draft the PRD** in the required-sections format.
4. **Emit the completion checklist** at the end — mark each section done or flag what's missing.
5. **Review with stakeholders** before handing to engineering — especially the success metric.

## Review checklist

- **Problem has evidence** — not intuition or executive preference.
- **User is specific** — a segment and role, not "users" or "everyone".
- **Metric is single and measurable** — not "improve UX" or "users will like it".
- **Acceptance criteria are testable** — a QA engineer can verify without asking the PM.
- **Non-goals are explicit** — not implied.
- **Completion checklist emitted** — all sections accounted for.

## Rules

- "The CEO wants it" is not a problem statement — push back and ask for user evidence.
- One success metric per PRD. Multiple metrics split attention and make post-launch evaluation ambiguous.
- Non-goals protect the team — be explicit and specific.
