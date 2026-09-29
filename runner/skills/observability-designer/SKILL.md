---
name: observability-designer
description: Use when adding observability to a new service, refactoring noisy alerting, or designing a monitoring strategy. Covers the three pillars (metrics/logs/traces), golden-signal dashboards, and alert-noise reduction. For SLO/error-budget math specifically, route to `slo-architect` instead.
stack: []
area: devops
---

# Design production-ready observability

Instrument a service so the on-call engineer can answer three questions without shipping
new code: is it broken for users, where, and why. Build on OpenTelemetry conventions so
signals correlate across services and vendors; page only on user-visible symptoms.
Line-level logging and span code belongs to the `structured-logging-and-tracing` skill;
SLO targets and burn-rate math belong to `slo-architect`.

## Signals and what each must carry

| Signal | Minimum contract |
|---|---|
| **Resource** | Every signal carries `service.name` (required by OTel), `service.version`, `deployment.environment.name` |
| **Metrics** | RED per endpoint (rate, errors, duration histogram), USE per resource (utilisation, saturation, errors). Use OTel semantic-convention names where they exist, e.g. `http.server.request.duration` |
| **Traces** | W3C `traceparent` propagated on every inbound and outbound hop (HTTP, queue messages, jobs); spans at process and dependency boundaries |
| **Logs** | Structured JSON with `trace_id` and `span_id` on every line emitted inside a request, so logs join traces |

Cardinality rule: metric labels come from bounded sets (route template, status class,
method). Never label by user ID, request ID, raw URL or error message — those go on spans
and logs.

## Procedure

1. **Read what exists.** `search_lore` for APM tooling, dashboard conventions, alert
   routing. Grep the repo for the telemetry SDK, exporter config, metric names and alert
   rule files. Extend in place; do not add a second telemetry stack.
2. **Map the service contract.** List the user-facing operations (endpoints, jobs,
   consumers) and each dependency. Each operation gets RED metrics and a span; each
   dependency gets a client span and error/latency metrics.
3. **Instrument the golden signals first** — latency, traffic, errors, saturation — for
   every user-facing path. Latency as a histogram (not a gauge of averages) so percentiles
   and SLO ratios can be computed.
4. **Make integrity failures observable.** Anything that can lose or duplicate data must
   emit a signal when it happens: lock/lease acquisition failures and takeovers of a
   "stale" lock, optimistic-concurrency conflicts and retries, dropped or dead-lettered
   messages, write acknowledgements vs. persisted count. Live runs lost acknowledged
   writes silently when a stale-lock lease was broken while the holder was merely paused;
   a counter on lease takeovers would have made it visible.
5. **Design dashboards top-down.** Service overview (the four golden signals + SLO
   status) → per-operation → per-dependency. Each panel answers one question; titles
   state the unit; SLO target drawn as a reference line.
6. **Define alerts.** Page only on symptoms users feel (SLO burn rate via `slo-architect`,
   or error/latency ratio when no SLO exists). Cause signals (CPU, disk, queue depth) go to
   dashboards or tickets unless they predict imminent user impact (disk full in < 4h).
   Every alert has: condition, window, severity (page/ticket), owner, runbook link to a
   specific section (the `runbook-generator` skill).
7. **Cut noise.** Require the condition to hold for a window (`for:`), deduplicate by
   service, group related alerts, silence during declared maintenance, delete alerts that
   paged without action in the last quarter.
8. **Verify** (below), then evidence each acceptance criterion with the `record-evidence`
   skill and stop.

## Verification

- Run the service or its integration tests locally and confirm one request produces: a
  metric increment, a span with the expected name and attributes, and a log line carrying
  the same `trace_id`. Record the command and the observed output.
- Propagation test: a request that crosses two components yields one trace, not two.
- Alert rules: validate with the platform's tool if the repo already uses it (e.g.
  `promtool check rules`, `promtool test rules`); dashboards: JSON parses and references
  only metrics the code emits (grep each name).
- Do not install new tooling to verify; if a validator is absent, say so in evidence.

## Review checklist (concrete defects only)

- A user-facing path in the ticket has no error or latency signal.
- A metric label is unbounded (IDs, raw paths, messages) — a cardinality incident.
- Context not propagated across an async boundary (queue, job, goroutine/thread pool).
- A secret, token or personal data field lands in a log, span attribute or label.
- A paging alert with no runbook link, no owner, or on a pure cause metric.
- Data-loss paths (lock takeover, conflict, dead letter) have no signal.

## Capture lore

**The repo's APM tooling, dashboard naming conventions, alert-channel routing, or on-call rotation policy — observability decisions are permanent and cost every future agent a re-search if undocumented.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
