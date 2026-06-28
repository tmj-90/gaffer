import { CompositeNotifier, NOOP_NOTIFIER } from "./notifier.js";
import { DesktopSink } from "./sinks/desktop.js";
import { SlackSink } from "./sinks/slack.js";
import { WebhookSink } from "./sinks/webhook.js";
import {
  isNotifyKind,
  NOTIFY_KINDS,
  type Notifier,
  type NotifyKind,
  type NotifySink,
} from "./types.js";

/**
 * Opt-in env flags that drive the notifier. Nothing set ⇒ no-op notifier.
 *
 *   - GAFFER_NOTIFY_WEBHOOK_URL  POST every gate as JSON to this URL (primary)
 *   - GAFFER_NOTIFY_SLACK_URL    Slack incoming-webhook URL (text variant)
 *   - GAFFER_NOTIFY_DESKTOP=1    fire a native desktop banner
 *   - GAFFER_NOTIFY_EVENTS       CSV allow-list of kinds; default = all gates
 *   - GAFFER_NOTIFY_REDACT=1     send a MINIMAL body (kind + ticket_number +
 *                                status + url only) — drops the agent-influenceable
 *                                free-text title/detail from outbound webhooks
 */
export const NOTIFY_ENV = {
  webhookUrl: "GAFFER_NOTIFY_WEBHOOK_URL",
  slackUrl: "GAFFER_NOTIFY_SLACK_URL",
  desktop: "GAFFER_NOTIFY_DESKTOP",
  events: "GAFFER_NOTIFY_EVENTS",
  redact: "GAFFER_NOTIFY_REDACT",
} as const;

/** Default allow-list: every human-gate kind fires. */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyKind[] = NOTIFY_KINDS;

/**
 * Parse the `GAFFER_NOTIFY_EVENTS` CSV into a kind allow-list. An empty/unset
 * value ⇒ the default (all gates). Unknown tokens are dropped (so a typo can
 * never silently enable nothing); if every token is unknown we fall back to the
 * default rather than producing an empty list that would mute notifications.
 */
export function parseAllowedEvents(raw: string | undefined): readonly NotifyKind[] {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_NOTIFY_EVENTS;
  const kinds = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .filter((s): s is NotifyKind => isNotifyKind(s));
  return kinds.length > 0 ? kinds : DEFAULT_NOTIFY_EVENTS;
}

/**
 * Build the {@link Notifier} from the environment. With no flags set this returns
 * the shared {@link NOOP_NOTIFIER} (zero overhead). Otherwise it assembles the
 * configured sinks and a {@link CompositeNotifier} over the allow-list.
 *
 * Pure w.r.t. `env` (defaults to `process.env`) so it's trivially testable.
 */
export function buildNotifierFromEnv(env: NodeJS.ProcessEnv = process.env): Notifier {
  const sinks: NotifySink[] = [];

  const webhookUrl = (env[NOTIFY_ENV.webhookUrl] ?? "").trim();
  if (webhookUrl !== "") sinks.push(new WebhookSink(webhookUrl));

  const slackUrl = (env[NOTIFY_ENV.slackUrl] ?? "").trim();
  if (slackUrl !== "") sinks.push(new SlackSink(slackUrl));

  if (isTruthyFlag(env[NOTIFY_ENV.desktop])) sinks.push(new DesktopSink());

  if (sinks.length === 0) return NOOP_NOTIFIER;

  const redact = isTruthyFlag(env[NOTIFY_ENV.redact]);
  return new CompositeNotifier(
    sinks,
    parseAllowedEvents(env[NOTIFY_ENV.events]),
    undefined,
    redact,
  );
}

/** A boolean env flag is on for "1"/"true"/"yes" (case-insensitive). */
function isTruthyFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
