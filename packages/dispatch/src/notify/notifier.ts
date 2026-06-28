import type { NotifyEvent, NotifyKind, NotifyLogger, Notifier, NotifySink } from "./types.js";

/** Logger default — wraps `console.warn` so prod logs land somewhere visible. */
const consoleLogger: NotifyLogger = {
  warn: (message: string) => console.warn(message),
};

/**
 * Reduce an event to a MINIMAL, redacted shape for outbound delivery: only the
 * structural fields an operator needs to triage (kind, ticket number, status, the
 * dashboard URL, and the timestamp). The free-text `title`/`detail` — which a
 * prompt-injected agent can influence via ticket content — and the `repo` name are
 * dropped, so nothing agent-controllable is exfiltrated to a webhook/Slack sink.
 */
export function redactEvent(event: NotifyEvent): NotifyEvent {
  return {
    kind: event.kind,
    at: event.at,
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.ticket_number !== undefined ? { ticket_number: event.ticket_number } : {}),
    ...(event.url !== undefined ? { url: event.url } : {}),
  };
}

/**
 * The real {@link Notifier}: a registry of sinks plus a gate allow-list. Firing
 * an event:
 *   1. drops it if its `kind` is not in the allow-list (filtered),
 *   2. otherwise fans it out to every sink, each isolated so one sink's failure
 *      can't stop the others or the caller.
 *
 * CRITICAL non-blocking contract: {@link notify} is synchronous and returns
 * immediately. Each sink's async `deliver` is fire-and-forget; a rejection is
 * caught and logged, NEVER propagated. The state transition that triggered the
 * notification is the source of truth — it must never roll back because a sink
 * threw. We swallow-with-log here, deliberately.
 */
export class CompositeNotifier implements Notifier {
  private readonly sinks: readonly NotifySink[];
  private readonly allow: ReadonlySet<NotifyKind>;
  private readonly logger: NotifyLogger;
  private readonly redact: boolean;

  constructor(
    sinks: readonly NotifySink[],
    allowedKinds: readonly NotifyKind[],
    logger: NotifyLogger = consoleLogger,
    redact = false,
  ) {
    this.sinks = sinks;
    this.allow = new Set(allowedKinds);
    this.logger = logger;
    this.redact = redact;
  }

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  notify(event: NotifyEvent): void {
    if (this.sinks.length === 0) return;
    if (!this.allow.has(event.kind)) return;
    // When redaction is on, strip agent-influenceable free text BEFORE the event
    // reaches any sink, so every outbound channel (webhook + Slack) gets the
    // minimal shape — one chokepoint rather than per-sink redaction.
    const outbound = this.redact ? redactEvent(event) : event;
    for (const sink of this.sinks) {
      this.fireOne(sink, outbound);
    }
  }

  /** Deliver to one sink, isolating both sync throws and async rejections. */
  private fireOne(sink: NotifySink, event: NotifyEvent): void {
    try {
      // `deliver` returns a promise; attach a rejection handler so an async
      // failure is logged, not turned into an unhandled rejection — and never
      // thrown back to the transition path.
      sink.deliver(event).catch((err: unknown) => this.logFailure(sink.name, err));
    } catch (err) {
      // A synchronous throw inside deliver (before it returns a promise) is
      // caught here for the same reason.
      this.logFailure(sink.name, err);
    }
  }

  private logFailure(sinkName: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`[notify] sink '${sinkName}' failed: ${message}`);
  }
}

/**
 * The zero-overhead default when nothing is configured. `enabled` is false and
 * `notify` is a no-op, so an unconfigured factory pays nothing.
 */
export const NOOP_NOTIFIER: Notifier = {
  enabled: false,
  notify(): void {
    /* intentionally empty — opt-in seam, no sinks configured */
  },
};
