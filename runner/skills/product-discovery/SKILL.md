---
name: product-discovery
description: Use when validating product opportunities, mapping assumptions, planning discovery sprints, or testing problem-solution fit before committing delivery resources. Triggers on "product discovery", "validate this idea", "opportunity solution tree", "discovery sprint", "assumption mapping", or "de-risk this bet".
stack: []
area: product
---

# De-risk product bets before building

Discovery's job is to fail fast and cheaply — identify wrong assumptions before they're baked into shipped software.

## Opportunity Solution Tree (Teresa Torres)

```
Desired outcome (metric to move)
  └── Opportunity (unmet user need / pain / desire)
       └── Solution idea (intervention)
            └── Experiment (cheapest test)
```

Rules:
- Opportunities come from user evidence — interviews, support tickets, analytics — not internal opinions.
- One desired outcome per tree. Multiple outcomes = no prioritisation.
- Solutions are hypotheses; experiments are the cheapest way to test each hypothesis.
- The tree is a living document — update as evidence accumulates.

## Assumption mapping

For each solution idea, map its assumptions across four risk dimensions:

| Dimension | Question | Example assumption |
|-----------|---------|-------------------|
| **Desirability** | Do users want this? | "Users will pay $10/month for this feature" |
| **Viability** | Does this create sustainable business value? | "This will reduce churn by 5%" |
| **Feasibility** | Can we build this? | "The API supports the required event granularity" |
| **Usability** | Can users use this without training? | "Users will understand the new onboarding flow without docs" |

Score each assumption: **Risk** (1–3) × **Certainty** (1–3 inverse — low certainty = high score). Highest scores = test first.

## Validation methods (choose by cost)

| Method | Cost | Validates |
|--------|------|----------|
| Desk research | Hours | Market size, competitor landscape, existing solutions |
| Customer interview (problem) | Days | Pain existence, frequency, severity, willingness to solve |
| Fake-door test | Days | Demand signal (click-through to a "coming soon" page) |
| Prototype usability test | Days–week | Usability, core interaction |
| Wizard-of-Oz / concierge | Week | Desirability + willingness to pay without building the feature |
| A/B experiment | Week–months | Behavioural impact on a metric |

**Fail fast principle:** choose the cheapest method that can kill or confirm the assumption. Don't spend a month building a prototype when 5 interviews would do.

## Discovery sprint structure (1–2 weeks)

1. **Week 1** — hypothesis formation + cheapest validation plan.
2. **Daily evidence reviews** — what did we learn today? Does it change the tree?
3. **End-of-sprint decision gate** — proceed (evidence supports the bet), pivot (evidence points to a different opportunity), or stop (evidence shows no opportunity).

## Steps

1. **Define the desired outcome.** One metric; baseline and target; time horizon.
2. **Build the OST.** Map opportunities from existing user evidence. Diverge before converging — generate many opportunities; then cluster and score by frequency × severity.
3. **Map assumptions for top opportunities.** Use the four dimensions. Identify the assumptions that would kill the bet if wrong.
4. **Plan experiments.** For each killer assumption: cheapest method that provides signal in < 1 week.
5. **Run experiments.** Document: hypothesis, method, result, what we concluded.
6. **Decision gate.** Proceed / pivot / stop with explicit reasoning. Capture in lore.

## Review checklist

- **Desired outcome specific** — one metric; measurable; time-bounded.
- **Opportunities from user evidence** — not internal brainstorms.
- **Killer assumptions identified** — the ones that, if wrong, kill the bet.
- **Cheapest validation method chosen** — not over-invested in expensive experiments for low-risk assumptions.
- **Decision gate explicit** — proceed/pivot/stop with documented reasoning.

## Rules

- Discovery debt is real: every feature shipped without discovery is a bet placed blind.
- User interviews discover problems; prototypes test solutions. Don't use interviews to validate solutions.
- A "proceed" decision without documented evidence is not a discovery output — it's a guess with extra steps.
