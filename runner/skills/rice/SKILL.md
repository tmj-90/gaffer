---
name: rice
description: Use when prioritising a feature backlog using RICE scoring (Reach, Impact, Confidence, Effort) or making a capacity-constrained prioritisation decision. Triggers on "prioritise these features", "RICE scoring", "what should we build first", "rank the backlog", or "capacity planning for the sprint".
stack: []
area: product
---

# Prioritise features with RICE scoring

RICE was developed at Intercom (Sean McBride, "RICE: Simple prioritization for product
managers"). It replaces the loudest voice with one formula applied to every candidate. The
score is an input to a decision, not the decision itself: it makes assumptions visible so
they can be argued about.

## The formula

```
RICE = (Reach × Impact × Confidence) / Effort
```

| Factor | Measures | Scale (Intercom's) |
|---|---|---|
| **Reach** | People or events affected **per fixed period** (e.g. customers per quarter) | a real count from data, never a 1–5 score |
| **Impact** | Effect on the chosen goal *per person reached* | 3 massive · 2 high · 1 medium · 0.5 low · 0.25 minimal |
| **Confidence** | How well-supported the Reach, Impact and Effort figures are | 100% high · 80% medium · 50% low; below 50% is a moonshot |
| **Effort** | Total team time: product, design and engineering | person-months (0.5 minimum; round up) |

## Calibration rules

- **One goal.** Impact only compares across items when every item is scored against the
  same metric, such as activation or retained accounts. Pick the metric first.
- **Reach comes from data.** Use analytics counts for the period ("1 200 accounts open
  export each quarter"). "All users" is not a reach.
- **Confidence tracks evidence**, not enthusiasm:
  - 100%: measured data or a completed experiment supports every factor.
  - 80%: one factor is an estimate backed by research.
  - 50%: mostly a guess.
- **Effort counts everyone.** It includes design, review and rollout time. Two engineers
  for one week is 0.5 person-months.
- **Write the assumption** behind every number next to it. A score without its reasoning
  cannot be challenged.

## Steps

1. **Fix the goal metric and the reach period.** Record both at the top of the sheet.
2. **List the candidates.** Include everything proposed and do not pre-filter. Split any
   item estimated at 5 person-months or more before scoring it.
3. **Score each factor**, with a one-line assumption per factor and its data source.
4. **Challenge confidence.** Lower any 80–100% that has no research or data behind it
   to 50%.
5. **Compute and sort** in descending order. For a CSV, compute
   `reach*impact*confidence/effort` with confidence as a decimal (0.8, not 80).
6. **Apply capacity** when planning a sprint or quarter. Take items from the top until
   the summed effort reaches capacity. Keep hard dependencies in order: an item that
   blocks a high scorer moves up with it.
7. **Sanity-review the top 5.** Where the ranking fights intuition, find which input
   causes it. Either correct the input or accept that intuition was wrong. Write down
   any deliberate override and the reason for it: strategy, a commitment, a risk, or
   tech debt that blocks others.

## Input format

```csv
feature,reach,impact,confidence,effort,assumptions
Bulk export,1200,1,0.8,1,"reach = Q2 export users; effort incl. design"
SSO,300,2,0.8,2,"reach = enterprise accounts; sales asks"
Mobile app,20000,3,0.5,8,"reach = MAU; impact a guess"
```

## Done when

- The goal metric and reach period are stated.
- Every item has all four factors, each with an assumption and its source.
- The list is sorted, the capacity cut-off is shown if one applies, and overrides are
  justified in writing.

## Anti-patterns

- Inventing 1–10 scales for Reach or Effort. The ratio then becomes meaningless.
- Confidence of 100% everywhere, which turns RICE into Reach × Impact / Effort.
- Comparing scores computed against different goal metrics.
- Treating RICE as an order to follow. Strategy, commitments and dependencies can
  override it, but only explicitly.
- Stale scores. Rescore when the goal, the data or the effort estimate changes, and
  always before a planning cycle.
