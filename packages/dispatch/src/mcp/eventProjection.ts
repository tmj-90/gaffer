import type { WorkEvent } from "../domain/types.js";

/**
 * Redacted projection of a {@link WorkEvent} for the MCP `get_ticket` response.
 *
 * SAFETY: this mirrors the activity-feed redaction principle established in
 * {@link import("../repositories/eventRepository.js").ActivityEvent} — events
 * handed back to an LLM carry metadata only (type, actor, timestamp) and NEVER
 * the raw `payload_json`. Raw payloads can hold free-text (AC text, block
 * reasons, decision answers, delivery summaries) which would otherwise leak
 * straight back into the model's context.
 *
 * `summary` is an OPTIONAL short, derived string built solely from an
 * allow-list of structurally-safe payload fields (status enums, evidence type,
 * repo role, decision status/severity). Free-text bodies are never copied.
 */
export interface ProjectedEvent {
  event_type: string;
  /** Actor that emitted the event, as `type` or `type:id`. */
  actor: string;
  created_at: string;
  /** Short, redacted/derived label — never the raw payload. */
  summary?: string;
}

/**
 * Allow-list of payload fields safe to surface in a summary. Each is an enum,
 * id, or boolean — never free text. Anything not listed here (reason, answer,
 * title, text, diff_summary, name, question, ...) is deliberately dropped.
 */
const SAFE_SUMMARY_FIELDS = ["from", "to", "evidence_type", "role", "status", "severity"] as const;

function actorLabel(event: WorkEvent): string {
  return event.actor_id ? `${event.actor_type}:${event.actor_id}` : event.actor_type;
}

/**
 * Parse `payload_json` and derive a short, safe summary from the allow-list.
 * Returns `undefined` when the payload is absent, unparseable, or contributes
 * no safe fields — so the caller simply omits `summary`.
 */
function deriveSummary(payloadJson: string | null): string | undefined {
  if (!payloadJson) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    // Malformed payloads never reach the model — drop the summary entirely.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const payload = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of SAFE_SUMMARY_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${field}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Project one raw work event into its redacted MCP shape. */
export function projectEvent(event: WorkEvent): ProjectedEvent {
  const summary = deriveSummary(event.payload_json);
  return {
    event_type: event.event_type,
    actor: actorLabel(event),
    created_at: event.created_at,
    ...(summary !== undefined ? { summary } : {}),
  };
}

/** Project a list of raw work events into redacted MCP shapes, order preserved. */
export function projectEvents(events: readonly WorkEvent[]): ProjectedEvent[] {
  return events.map(projectEvent);
}
