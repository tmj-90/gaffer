---
name: slo-architect
description: Use when defining, reviewing, or operating SLOs and SLIs — error budgets, burn-rate alerting, SLO review gates. Triggers on "define an SLO", "error budget", "burn rate", "SLI", "multi-window burn-rate alert", or any reliability-target question. For broader dashboard/alert-noise work, route to `observability-designer`.
stack: []
area: devops
---

# Define SLOs that mean something

An SLO is a promise about user-visible behaviour, measured by an SLI, with an error budget
and an agreed policy for spending it. Most "SLOs" in the wild are round numbers with no SLI
definition and no policy. This skill follows the Google SRE Workbook chapters
"Implementing SLOs" and "Alerting on SLOs".

## Vocabulary and the math you must get right

```
SLI          = good events / valid events           (ratio, 0..1, over a window)
SLO          = target for the SLI over a window      e.g. 99.9% over a rolling 28/30 days
error budget = 1 − SLO                               e.g. 0.1% of valid events
burn rate    = observed error ratio / (1 − SLO)      1.0 = budget lasts exactly the window
alert burn threshold = (budget fraction consumed × SLO window) / alert window
                       e.g. 2% of 30d in 1h → 0.02 × 720h / 1h = 14.4
```

Express the budget in the unit users feel: for 99.9% over 30 days that is 43.2 minutes of
full outage, or 1,000 failed requests per 1,000,000.

## Procedure

1. **Read what exists.** `search_lore` for existing SLOs, alert channels, telemetry stack.
   Find the metric names actually emitted (grep the instrumentation code and the alert
   rules). Never define an SLI on a metric nobody emits.
2. **Pick the SLI from the user's journey.** Availability (non-5xx / valid requests),
   latency (requests faster than a threshold / valid requests — a ratio, not a p99
   average), freshness, correctness, durability for storage. Write both the
   *specification* ("proportion of checkout requests served successfully") and the
   *implementation* (the exact query, the load-balancer or server metric, what counts as
   valid — e.g. exclude 4xx caused by the client). CPU, memory and queue depth are causes,
   not SLIs.
3. **Include correctness where writes matter.** For any service that accepts writes, an
   acknowledged write that is later lost is the worst failure and is invisible to an
   availability SLI. Add a durability/correctness SLI (e.g. read-after-acknowledged-write
   probe success) or state explicitly why it is out of scope.
4. **Set a believable target from data.** Measure the SLI over the last 4+ weeks. Set the
   SLO at or slightly below what you already achieve in ~90% of windows. A 99.9% target on a
   service that regularly sits at 99.5% is theatre; 100% is never a valid target.
5. **Wire multiwindow, multi-burn-rate alerts** (Workbook defaults for a 30-day SLO; the
   short window is 1/12 of the long one and both must breach):

   | Budget consumed | Long window | Short window | Burn rate | Action |
   |---|---|---|---|---|
   | 2% | 1h | 5m | 14.4 | Page |
   | 5% | 6h | 30m | 6 | Page |
   | 10% | 3d | 6h | 1 | Ticket |

   Expression shape: `error_ratio[1h] > 14.4 × (1 − SLO) AND error_ratio[5m] > 14.4 × (1 − SLO)`.
   For low-traffic services (a few requests per window) add synthetic probes, aggregate
   related endpoints, or lengthen windows — otherwise one failure pages.
6. **Write the error-budget policy** before the SLO is "active": who decides, and what
   happens when the budget is exhausted over the window (Workbook example: halt feature
   releases except P0 and security fixes until back within SLO; any single incident
   consuming >20% of the budget gets a postmortem with at least one P0 action item).
7. **Document the SLO** next to the service (e.g. `docs/slo/<service>.md`): SLI spec and
   implementation, target, window, budget in minutes/requests, alert rules, policy,
   owner, next review date.
8. **Verify** (see below), evidence each acceptance criterion with the
   `record-evidence` skill, then stop.

## Verification

- Every metric in the SLI query exists: grep the instrumentation, or run the query in a
  test harness / recording-rule unit test (`promtool test rules` for Prometheus, if the
  repo already uses it).
- Replay a known incident or a synthetic error series through the alert rules: the 14.4
  page must fire within minutes of a total outage; a 5-minute blip at 2× error rate must
  not page. Record the command and output.
- Recompute the budget arithmetic by hand in the doc (window × (1 − SLO)).

## Review checklist (concrete defects only)

- SLI is a ratio of good/valid events on a user-facing boundary, and the query matches
  the documented specification.
- Target is justified by measured history, not a round number.
- Budget stated in minutes and/or events; arithmetic correct.
- Alerts are multiwindow (long AND short) with the burn rates above or a documented
  derivation; a single-window or raw-threshold alert is a defect.
- Every paging alert links a runbook section (the `runbook-generator` skill).
- Error-budget policy exists and names an owner.

## Anti-patterns

- Averages or p99 over a window as the SLI instead of a good/valid ratio.
- One SLO per endpoint for dozens of endpoints — group by user journey.
- Alerting on budget exhausted (too late) or on raw error rate > X% (noisy).
- Declaring success because the SLO dashboard is green while no durability signal exists.

## Capture lore

Agreed SLO targets, SLI definitions, budget policies and alert channels are high-leverage
facts: call `suggest_lore` once with `tags: [slo, reliability, alerting]`.
