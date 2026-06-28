---
name: rice
description: Use when prioritising a feature backlog using RICE scoring (Reach, Impact, Confidence, Effort) or making a capacity-constrained prioritisation decision. Triggers on "prioritise these features", "RICE scoring", "what should we build first", "rank the backlog", or "capacity planning for the sprint".
stack: []
area: product
---

# Prioritise features with RICE scoring

RICE cuts through "loudest voice" prioritisation. Every feature gets a score from the same formula; the list sorts itself.

## The formula

```
RICE = (Reach × Impact × Confidence) / Effort
```

| Factor | What it measures | Scale |
|--------|-----------------|-------|
| **Reach** | Users affected per time period (e.g. per quarter) | Raw number (not a 1–5 scale) |
| **Impact** | Effect on the metric per user who encounters the feature | 0.25 (minimal) / 0.5 / 1 / 2 / 3 (massive) |
| **Confidence** | How certain are the estimates? | 0.5 (low) / 0.8 (medium) / 1.0 (high) |
| **Effort** | Person-months of work | Raw number (not a 1–5 scale) |

A higher score = build sooner. Within a sprint, also apply capacity constraints (effort sum ≤ sprint capacity).

## Common calibration mistakes

- **Reach is per time period** — "all users" is meaningless; specify the window (per quarter / per month).
- **Impact uses the fixed scale** — resist the urge to invent 1–10 scales; the fixed scale forces honest comparisons.
- **Confidence should hurt** — if you're guessing, use 0.5. Most estimates that feel like 0.8 are actually 0.5.
- **Effort in person-months** — a 1-week task for 2 engineers = 0.5 person-months, not 1.

## Steps

1. **Define the metric.** RICE scores are only comparable when measuring impact on the *same* metric. Establish the North Star before scoring.
2. **List features.** Collect all candidates. Don't pre-filter — let scoring do the filtering.
3. **Score each feature** using the four factors. Be explicit about assumptions; document them next to the score.
4. **Apply confidence calibration.** Push back on confidence scores above 0.8 unless there is user research, analytics, or a successful prior experiment behind the estimate.
5. **Rank.** Sort descending by RICE score.
6. **Apply capacity constraints** (if sprint planning). Sum effort from the top until capacity is consumed. Flag any item ≥ 5 person-months for decomposition.
7. **Sanity-check the top 5.** Do the top items match intuition? If not — is the formula right, or is intuition wrong? Challenge both.

## CSV input format (for batch scoring)

```csv
feature,reach,impact,confidence,effort
Dark mode,5000,1,0.8,0.5
API v2,12000,2,0.9,3
SSO integration,3000,1,0.7,2
Mobile app,20000,3,0.5,8
```

RICE score = (reach × impact × confidence) / effort. Sort descending.

## Review checklist

- **North Star metric defined** — all impact scores reference the same metric.
- **Reach is time-bounded** — "per quarter" or "per month"; not an absolute number.
- **Confidence calibrated honestly** — no confidence > 0.8 without user research or prior experiment.
- **Effort in consistent units** — person-months across all items.
- **Top 5 sense-checked** — scoring result reviewed against team intuition; discrepancies investigated.

## Rules

- Don't skip features before scoring — your gut's ranking is exactly what RICE is designed to override.
- Confidence 1.0 requires a completed experiment or hard data; 0.8 requires prior research; everything else is 0.5.
- RICE scores become stale in ≥ 3 months — rescore before a major planning cycle.
