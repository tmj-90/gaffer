---
name: structured-logging-and-tracing
description: Use when a ticket adds or changes what a service records about itself — log lines, metrics, spans, correlation ids — and the output must be structured, correlated across processes, safe (no secrets or personal data), and useful to the person debugging at 3am. Invoke for "add logging for X", "we can't see why Y fails", "add a metric", "propagate the request id", or when an incident review asks for observability in code.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Instrument code with structured logs, metrics and traces

Observability is designed where the code knows what happened. Emit events a machine can
filter and a human can read, carry one trace context through every hop, measure the few
things an alert needs, and never write a secret or a person's data into a log that lives
for ninety days. Sources: W3C Trace Context (Recommendation); OpenTelemetry semantic
conventions (HTTP spans and metrics, log data model); OWASP Logging Cheat Sheet; Google
SRE book ch. 6 (four golden signals).

## Steps

1. **Use the repo's instrumentation.** Find the structured logger, metrics client,
   tracing SDK (OpenTelemetry if present) and the correlation convention. Call
   `search_lore` for standard field names (`request_id`, `ticket`, `duration_ms`). A
   second logger or tracer is a defect.
2. **Log events, not sentences.** One record per meaningful event: stable event name
   plus typed fields, e.g. `{"event":"claim.released","ticket":42,"reason":"ttl_expired"}`,
   not `"released ticket " + n`. Units in field names (`duration_ms`, `size_bytes`).
   The logger's serialiser escapes values, which also stops log injection (CR/LF in
   user input forging lines); never build log lines by concatenation.
3. **Choose levels deliberately.** `error`: a failure someone must act on. `warn`:
   degraded but handled. `info`: state transitions an operator follows. `debug`: the
   rest. A swallowed exception is logged with its error class and cause, never at
   `debug` only.
4. **Propagate trace context across every hop.** Accept and emit W3C `traceparent`
   (`00-<32 hex trace-id>-<16 hex span-id>-<flags>`) and `tracestate` on HTTP; put the
   same fields in queue message headers and job payloads, and pass them to spawned
   processes (env or argument). Stamp `trace_id` and `span_id` on every log record in
   that unit of work (OTel log correlation). If the repo also has a `request_id`, carry
   both. Do not put secrets or personal data in `baggage`; it travels to third parties.
5. **Add spans at slow or flaky boundaries** — inbound requests, outbound HTTP, DB
   queries, queue publish/consume, subprocesses — using the SDK's auto-instrumentation
   where it exists. Follow semantic conventions: HTTP span name `{method} {route}`
   (`GET /tickets/{id}`, never the raw URL with ids), attributes `http.request.method`,
   `http.route`, `http.response.status_code`, `server.address`, `error.type`. Status:
   server spans mark `5xx` as Error and leave `4xx` unset; client spans mark both `4xx`
   and `5xx` as Error. Record the exception on the span; never attach payloads.
6. **Measure what an alert would use.** The golden signals for the operation: a
   duration histogram (OTel: `http.server.request.duration`, seconds), a counter of
   outcomes by result, and saturation gauges (queue depth, pool in-use). Metric labels
   are low-cardinality (route template, status class, kind); user ids, ticket numbers,
   URLs and error messages go on spans or logs, never labels. Alert design: the
   `observability-designer` skill.
7. **Log the security-relevant events** (OWASP): authentication success and failure,
   authorisation denials, input-validation failures at trust boundaries, admin and
   permission changes, with who, what, when, from where and outcome.
8. **Redact by construction.** Never log passwords, tokens, session ids, API keys,
   `Authorization`/`Cookie` headers, full request or response bodies, or personal data
   beyond need. Allow-list emitted fields or use the repo's redaction helper; hash an
   identifier if correlation is needed (the `data-privacy` skill).

## Tests (in-memory exporters and a captured logger)

- The event is emitted once with the expected name, level and fields.
- **Propagation:** an inbound `traceparent` produces child spans with the same trace id,
  the outbound call and the enqueued job carry it, and the worker's logs show that trace id.
- **Concurrency:** two interleaved requests (parallel, not sequential) each log only
  their own `trace_id`/`request_id` — context does not leak between async tasks
  (AsyncLocalStorage, `contextvars`, `context.Context`).
- A failure path sets span status Error, records the exception, and increments the
  failure counter.
- **Redaction:** a request carrying a token, password and email produces no log or span
  containing those values (assert on the captured output).

## Done when

The tests above pass for the instrumented path, a sample record and span are captured
in the evidence, and each acceptance criterion has evidence via the `record-evidence`
skill.

## Review checklist

- [ ] The repo's logger/metrics/tracer only; structured records with stable names.
- [ ] Trace context propagated over HTTP, queues and subprocesses; ids on every record.
- [ ] Span names low-cardinality; status rules per semantic conventions.
- [ ] Metric labels low-cardinality; units stated.
- [ ] No secrets, tokens, bodies or unnecessary personal data; redaction tested.
- [ ] Handled failures visible at the right level, never silent.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While instrumenting you learn the field names, the correlation mechanism and the redaction rules the observability stack expects.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
