/**
 * H2 human-gate notifications — the structured event shape and the seam
 * interfaces.
 *
 * The factory runs unattended, but a handful of transitions need a human:
 * a ticket entering `in_review`, a ticket parked/`blocked`, or a decision
 * becoming pending. Those are "human gates". This module is an opt-in,
 * pluggable seam that pings the operator when one fires, so they don't have to
 * watch the dashboard.
 *
 * Design rules (see {@link Notifier}):
 *   - best-effort: a sink failure is caught + logged, NEVER propagated — the
 *     state transition is the source of truth and must never roll back because a
 *     webhook 500'd.
 *   - opt-in: when nothing is configured the notifier is a no-op with zero
 *     overhead (see {@link config.buildNotifierFromEnv}).
 *   - injectable: the facade takes a {@link Notifier}, so tests pass a fake.
 */

/**
 * The human-gate kinds a sink can fire on. This is also the default allow-list
 * (every gate kind) — see {@link config.DEFAULT_NOTIFY_EVENTS}.
 *
 *   - `review_needed`    a ticket entered `in_review` (awaiting a reviewer)
 *   - `ticket_blocked`   a ticket entered `blocked` (an agent/operator block)
 *   - `ticket_parked`    a delivery exhausted its retry budget and was parked to
 *                        `blocked` (needs-human) — distinct from a plain block so
 *                        an operator can route the two differently
 *   - `decision_pending` a decision was raised and is awaiting a human answer
 */
export const NOTIFY_KINDS = [
  "review_needed",
  "ticket_blocked",
  "ticket_parked",
  "decision_pending",
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** True iff `value` is a known {@link NotifyKind}. */
export function isNotifyKind(value: string): value is NotifyKind {
  return (NOTIFY_KINDS as readonly string[]).includes(value);
}

/**
 * The structured, templated event a sink receives. Deliberately small and flat
 * so every sink (webhook JSON, Slack text, desktop banner) can template it the
 * same way.
 */
export interface NotifyEvent {
  /** The human-gate kind that fired. */
  readonly kind: NotifyKind;
  /** Ticket number (e.g. 42) when the gate is ticket-scoped. */
  readonly ticket_number?: number;
  /** Short human title — the ticket title or the decision title. */
  readonly title?: string;
  /** Ticket status at the gate (e.g. "in_review", "blocked"). */
  readonly status?: string;
  /** Repo name, when one is associated. */
  readonly repo?: string;
  /** A deep link the operator can click (dashboard ticket URL). */
  readonly url?: string;
  /** ISO-8601 timestamp the gate fired. */
  readonly at: string;
  /** Free-text extra context (reason, attempt count, …). */
  readonly detail?: string;
}

/**
 * A pluggable destination for a {@link NotifyEvent}. A sink does the actual
 * delivery (HTTP POST, spawn a notifier binary, …). It MAY reject — the
 * surrounding {@link Notifier} isolates the failure.
 */
export interface NotifySink {
  /** Stable identifier for logs/tests (e.g. "webhook", "slack", "desktop"). */
  readonly name: string;
  /** Deliver one event. May reject; the caller isolates failures. */
  deliver(event: NotifyEvent): Promise<void>;
}

/**
 * The seam the facade depends on. {@link CompositeNotifier} is the real one;
 * {@link NOOP_NOTIFIER} is the zero-overhead default when nothing is configured.
 */
export interface Notifier {
  /**
   * Fire an event through every configured sink, best-effort and non-blocking.
   * MUST NOT throw and MUST NOT reject in a way that can break the caller — a
   * sink failure is swallowed-with-log inside the implementation.
   */
  notify(event: NotifyEvent): void;
  /** True when at least one sink is active (lets callers skip building events). */
  readonly enabled: boolean;
}

/**
 * Injectable HTTP transport for the webhook/slack sinks, so tests pass a fake
 * instead of hitting the network. Mirrors the slice of `fetch` we use.
 */
export interface HttpTransport {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean; status: number }>;
}

/** Result of running an external command (the desktop notifier binary). */
export interface CommandResult {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Injectable command runner for the desktop sink, so tests assert the spawned
 * argv without a real binary on the box. Returns a result rather than throwing
 * on a non-zero exit; an absent binary surfaces as a thrown error the sink
 * degrades on gracefully.
 */
export interface CommandRunner {
  (command: string, args: readonly string[]): CommandResult;
}

/** Minimal logger seam (defaults to `console`) so tests can capture warnings. */
export interface NotifyLogger {
  warn(message: string): void;
}
