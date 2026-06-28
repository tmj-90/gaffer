import type { HttpTransport, NotifyEvent, NotifySink } from "../types.js";
import { WebhookSink } from "./webhook.js";

/**
 * Slack incoming-webhook sink — a webhook variant. Slack's incoming webhooks
 * expect a `{ text: ... }` JSON body, not our raw event shape, so this sink
 * renders the event to a one-line message and POSTs that. It reuses
 * {@link WebhookSink} for the transport/timeout/non-2xx handling so there's one
 * code path for "POST JSON to a URL".
 */
export class SlackSink implements NotifySink {
  readonly name = "slack";
  private readonly inner: WebhookSink;

  constructor(url: string, transport?: HttpTransport, timeoutMs?: number) {
    // Wrap the URL in a transport that rewrites the body to Slack's shape. The
    // event is templated to text here; WebhookSink JSON-stringifies the {text}.
    const slackTransport: HttpTransport = (target, init) => {
      const event = JSON.parse(init.body) as NotifyEvent;
      const slackBody = JSON.stringify({ text: renderSlackText(event) });
      return (transport ?? defaultFetch)(target, { ...init, body: slackBody });
    };
    this.inner = new WebhookSink(url, slackTransport, timeoutMs ?? undefined, "slack");
  }

  deliver(event: NotifyEvent): Promise<void> {
    return this.inner.deliver(event);
  }
}

/** Default transport (platform fetch) when none is injected. */
const defaultFetch: HttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

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
