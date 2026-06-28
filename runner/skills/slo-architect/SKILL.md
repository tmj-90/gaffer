---
name: slo-architect
description: Use when defining, reviewing, or operating SLOs and SLIs — error budgets, burn-rate alerting, SLO review gates. Triggers on "define an SLO", "error budget", "burn rate", "SLI", "multi-window burn-rate alert", or any reliability-target question. For broader dashboard/alert-noise work, route to `observability-designer`.
stack: []
area: devops
---

# Define SLOs that mean something

Most "SLOs" in the wild are arbitrary numbers no one believes — 99.9% on every endpoint, no SLI definition, no error budget, no policy for when budget burns. This skill enforces the discipline from Google's SRE Workbook.

## Four cardinal mistakes

1. **Target too high** (99.99%+ on services that can't support it) — every minor blip violates; alerts become noise.
2. **Wrong SLI** (CPU usage as proxy for user experience) — system green while users suffer.
3. **No error-budget policy** — burning budget means nothing if there is no agreed action.
4. **Single-window burn-rate alert** — either too noisy (page on a 5-min spike) or too slow (notice budget exhausted after the fact).

## Core vocabulary

```
SLI  → measurable signal of user-perceived health (e.g. HTTP 2xx rate, p99 latency)
SLO  → target for the SLI over a rolling window (e.g. 99.9% over 30 days)
EB   → error budget: (100% − SLO%) × window = how much "bad" you can spend
BR   → burn rate: how fast you're consuming the error budget right now
```

## Steps

1. **Pick the right SLI.** Choose a measurement that reflects user experience, not system internals. Event-based (good events / total events) is usually cleaner than time-window averages.
2. **Set a believable target.** Measure your actual reliability first. Set the SLO at or below the 10th percentile of your measured per-window reliability (a level you already meet in ~90% of windows) so it's meaningful but achievable. 99.9% on a service that regularly drops to 99.5% is theatre.
3. **Calculate the error budget.** For 99.9% over 30 days: budget = 0.1% × 30d = 43.2 minutes of downtime. Document this number explicitly.
4. **Wire multi-window burn-rate alerts.** Two windows (short + long) with two burn rates. Canonical Google SRE thresholds: 2% budget in 1h (fast burn, page now) + 5% budget in 6h (slow burn, ticket). Adapt to your SLO window.
5. **Write the error-budget policy.** What happens when >50% of budget is gone mid-window? Freeze feature work, hold risky deploys, escalate. Get agreement before the SLO ships.
6. **Set a review cadence.** Review SLOs quarterly: are they still meaningful? Are they achievable? Do they map to what users actually care about?
7. **Verify + evidence.** Run burn-rate alert thresholds against a replay of the last incident; confirm the fast-burn alert would have fired within 5 min of the outage start. Record output via `record-evidence`.

## Build / Test

- Validate alert thresholds against at least one historical incident replay before deploying.
- For each SLO: confirm the SLI definition is measurable in the current telemetry stack (no phantom metrics).
- Check that the error-budget policy is written, reviewed, and linked from the SLO doc.

## Review checklist

- **SLI maps to user experience** — not a proxy like CPU or queue depth.
- **Target is believable** — grounded in historical data, not a round number.
- **Error budget is explicit** — stated in minutes/requests, not just a percentage.
- **Multi-window burn-rate alerts** — fast and slow windows both wired; single-window rejected.
- **Error-budget policy exists** — agreed action for when budget is > 50% consumed.
- **SLO review cadence scheduled** — quarterly or at major reliability incidents.

## Rules

- Never set an SLO without first measuring the current baseline.
- Reject SLOs that use infrastructure metrics (CPU, memory) as SLIs.
- Every SLO must have an error-budget policy before it's considered active.

## Capture lore

SLO decisions are among the highest-leverage lore a future agent can inherit. When you learn the agreed SLO targets, SLI definitions, error-budget policies, and alert channels for this repo, call `suggest_lore` once with `tags: [slo, reliability, alerting]`.
