---
name: observability-designer
description: Use when adding observability to a new service, refactoring noisy alerting, or designing a monitoring strategy. Covers the three pillars (metrics/logs/traces), golden-signal dashboards, and alert-noise reduction. For SLO/error-budget math specifically, route to `slo-architect` instead.
stack: []
area: devops
---

# Design production-ready observability

Instrument services so operators know what is broken, why, and where — before users notice. Three pillars, golden signals, low-noise alerting.

## The three pillars

| Pillar | Purpose | Key decision |
|--------|---------|-------------|
| **Metrics** | Rate, latency, saturation at a glance | RED method for services; USE method for resources |
| **Logs** | Structured event trail with correlation IDs | JSON, log-level discipline, sample high-volume streams |
| **Traces** | End-to-end request flow across services | Meaningful span boundaries; tail-based sampling for slow/erroring requests |

Golden signals to define first: **latency, traffic, errors, saturation** — cover these before anything else.

## Steps

1. **Read the lore first.** `search_lore` for existing observability decisions (dashboards, alert channels, on-call runbooks, APM tooling). Extend in place; don't duplicate.
2. **Identify the service contract.** What does this service promise users? That contract → the SLIs. Route SLO/error-budget design to `slo-architect`.
3. **Design dashboards.** Overview → service → component drill-down. Max 7±2 panels per screen; colour semantics (red = critical, amber = warning, green = healthy); SLO target reference lines.
4. **Define alert thresholds.** Prefer symptom-based over cause-based alerts. Require every alert to have: condition, severity, runbook link, on-call owner. Suppress during known maintenance.
5. **Reduce noise.** Deduplicate, set appropriate alert-evaluation windows, distinguish pager alerts (must wake someone) from dashboard-only signals.
6. **Verify + evidence.** Deploy to staging, confirm every golden-signal panel renders with live data; run `record-evidence` with test output; submit for review.

## Build / Test

- Validate dashboard JSON against the target platform's schema (Grafana, Datadog, CloudWatch) before committing.
- Alert configs: dry-run evaluation against recent telemetry; confirm alert-to-runbook coverage is 1:1.
- Structured logging: emit a test event and confirm all required fields appear in the aggregation layer.

## Review checklist

- **Golden signals covered** — latency/traffic/errors/saturation panels present for every user-facing path.
- **Alert hygiene** — every alert has severity, condition, and runbook link; no alert fires without a defined owner.
- **Noise budget** — alert evaluation windows are wide enough to avoid flapping; non-actionable signals are dashboard-only.
- **Correlation IDs** — all logs carry a request/trace ID so a single request can be followed across services.
- **No SLI/SLO work here** — SLO targets and error-budget math delegated to `slo-architect`.

## Rules

- Every alert must have a runbook link before it ships to production.
- Symptom-based alerts (user-perceived latency/error rate) take priority over cause-based (CPU %).
- Do not instrument everything — start with golden signals and add only when a gap causes a missed incident.

## Capture lore

Observability decisions are permanent choices that cost every future agent a re-search if undocumented. When you learn the repo's APM tooling, dashboard naming conventions, alert-channel routing, or on-call rotation policy, call `suggest_lore` once:

- `title` — the fact in a few words.
- `summary` — what it is and why it was decided.
- `tags` — `observability`, `alerting`, `monitoring`.
- `confidence` — `high` only with a source (ADR, PR, doc link).
