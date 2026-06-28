/**
 * H2 human-gate notifications — public surface.
 *
 * An opt-in, pluggable seam that pings the operator when the factory needs a
 * human: a ticket entering `in_review`, a ticket parked/`blocked`, or a decision
 * becoming pending. Wired into the {@link Dispatch} facade; see
 * {@link buildNotifierFromEnv} for the env-driven default and {@link Notifier}
 * for the best-effort, non-blocking contract.
 *
 * Deferred (do NOT build here — these touch the runner / H1 budget surfaces):
 *   - budget-threshold notifications (run cost crossing a configured ceiling),
 *   - run-finished / run-failed notifications.
 * Both belong to the runner's tick loop, not the dispatch gate transitions this
 * branch scopes, so they are intentionally left as follow-ups.
 */
export {
  NOTIFY_KINDS,
  isNotifyKind,
  type CommandResult,
  type CommandRunner,
  type HttpTransport,
  type Notifier,
  type NotifyEvent,
  type NotifyKind,
  type NotifyLogger,
  type NotifySink,
} from "./types.js";
export { CompositeNotifier, NOOP_NOTIFIER, redactEvent } from "./notifier.js";
export {
  buildNotifierFromEnv,
  parseAllowedEvents,
  DEFAULT_NOTIFY_EVENTS,
  NOTIFY_ENV,
} from "./config.js";
export { WebhookSink, DEFAULT_WEBHOOK_TIMEOUT_MS } from "./sinks/webhook.js";
export { SlackSink, renderSlackText } from "./sinks/slack.js";
export { DesktopSink } from "./sinks/desktop.js";
