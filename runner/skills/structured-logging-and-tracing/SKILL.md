---
name: structured-logging-and-tracing
description: Use when a ticket adds or changes what a service records about itself — log lines, metrics, spans, correlation ids — and the output must be structured, correlated across processes, safe (no secrets or personal data), and useful to the person debugging at 3am. Invoke for "add logging for X", "we can't see why Y fails", "add a metric", "propagate the request id", or when an incident review asks for observability in code.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Instrument code with structured logs, metrics and traces

Observability is designed at the point where the code knows what happened. Emit events
a machine can filter and a human can read, carry one correlation id through every hop,
measure the few things that matter, and never write a secret or a person's data into a
log that lives for ninety days.

## Steps

1. **Use the repo's instrumentation, not a new one.** Find the structured logger, the
   metrics client, the tracing SDK and the correlation-id convention (a header, an env
   var, a context object). Call `search_lore` for field names the repo standardises on
   (`ticket`, `request_id`, `duration_ms`). Adding a second logger is a defect.
2. **Log events, not sentences.** One structured record per meaningful event with a
   stable event name and typed fields (`{"event":"claim.released","ticket":42,
   "reason":"ttl_expired"}`), not `console.log("released ticket " + n)`. Sentences are
   for the message field; facts are fields.
3. **Choose levels deliberately.** `error` for a failure someone must act on, `warn` for
   a degraded-but-handled path, `info` for state transitions an operator wants to
   follow, `debug` for the rest. Logging every request at `info` is noise; logging an
   ignored failure at `debug` is a cover-up.
4. **Propagate the correlation id.** Read it at the edge (request header, job payload,
   the tick id the runner sets), attach it to every log record and span in that unit of
   work, and pass it to every downstream call and spawned process. A log you cannot
   join to its request is a log you cannot use.
5. **Add spans for the slow or flaky boundaries**: outbound HTTP, database queries,
   queue operations, agent spawns. Name spans by operation, add the identifying
   attributes (not payloads), and record the error status on failure.
6. **Measure what an alert would use.** A counter for outcomes by result, a histogram for
   latency of the operation, a gauge for a queue depth. Labels are low-cardinality
   (status, kind), never a user id or a ticket number. See the `observability-designer`
   skill for the alerting side.
7. **Redact by construction.** Never log secrets, tokens, passwords, full request bodies,
   or personal data. Use the repo's redaction helper or allow-list the fields you emit.
   Assume every log line will be read by someone who should not see the payload.
8. **Test the instrumentation** where it carries meaning: the event is emitted with the
   right fields, the correlation id survives a hop, the metric increments on the
   outcome. Evidence with the `record-evidence` skill, including a sample record.

## Rules

- One logger, one metrics client, one tracer: the repo's.
- Structured records with stable event names and typed fields; no string concatenation.
- Correlation id on every record and every hop.
- Low-cardinality labels; no ids in metric labels.
- No secrets, bodies, or personal data in logs or spans, ever.
- Levels mean something; a handled failure is never silent and never `error`.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While instrumenting you learn the field names, the correlation mechanism and the redaction rules the observability stack expects.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
