import type { HttpTransport, NotifyEvent } from "../types.js";
import { WebhookSink } from "./webhook.js";

/**
 * Slack incoming-webhook sink — a webhook variant. Slack's incoming webhooks
 * expect a `{ text: ... }` JSON body, not our raw event shape, so this sink
 * extends {@link WebhookSink} and overrides its body builder to render the
 * TYPED event to a one-line message (H6). Transport, timeout, and non-2xx
 * handling are inherited unchanged, so there is one code path for "POST JSON to
 * a URL" and no JSON round-trip of the event through a string body.
 */
export class SlackSink extends WebhookSink {
  constructor(url: string, transport?: HttpTransport, timeoutMs?: number) {
    super(url, transport, timeoutMs ?? undefined, "slack");
  }

  protected override renderBody(event: NotifyEvent): string {
    return JSON.stringify({ text: renderSlackText(event) });
  }
}

/** Render a {@link NotifyEvent} to a single Slack message line. */
export function renderSlackText(event: NotifyEvent): string {
  const head = HEADINGS[event.kind];
  const ticket = event.ticket_number !== undefined ? ` #${event.ticket_number}` : "";
  const title = event.title ? ` ${event.title}` : "";
  const detail = event.detail ? ` — ${event.detail}` : "";
  const link = event.url ? ` ${event.url}` : "";
  return `${head}${ticket}:${title || " (untitled)"}${detail}${link}`.trim();
}

const HEADINGS: Record<NotifyEvent["kind"], string> = {
  review_needed: "🔎 Review needed",
  ticket_blocked: "⛔ Ticket blocked",
  ticket_parked: "🅿️ Ticket parked",
  decision_pending: "❓ Decision pending",
};
