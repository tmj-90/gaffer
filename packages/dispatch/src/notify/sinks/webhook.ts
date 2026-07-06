import type { HttpTransport, NotifyEvent, NotifySink } from "../types.js";

/**
 * The default HTTP transport: the platform `fetch`. Wrapped so the sink only
 * depends on the {@link HttpTransport} slice and tests can swap a fake in. Node
 * 20+ (the engine floor) ships a global `fetch`, so no dependency is needed.
 */
const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

/**
 * The generic enterprise webhook sink — the primary integration. It POSTs the
 * {@link NotifyEvent} as a JSON body to a configured URL, so any system that can
 * receive a webhook (an internal bot, a queue, a paging service) gets the gate.
 *
 * Delivery is allowed to fail loudly here (a rejected promise / non-2xx throws);
 * the surrounding {@link CompositeNotifier} isolates that so a transition never
 * breaks. A short timeout keeps a hung endpoint from holding the event-loop slot.
 */
export class WebhookSink implements NotifySink {
  readonly name: string;

  constructor(
    private readonly url: string,
    private readonly transport: HttpTransport = fetchTransport,
    private readonly timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
    name = "webhook",
  ) {
    this.name = name;
  }

  async deliver(event: NotifyEvent): Promise<void> {
    const res = await withTimeout(
      this.transport(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.renderBody(event),
      }),
      this.timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`webhook POST to ${redact(this.url)} returned ${res.status}`);
    }
  }

  /**
   * Serialise the event into the POST body. The generic webhook posts the raw
   * {@link NotifyEvent} as JSON; subclasses (e.g. {@link SlackSink}) override
   * this to emit a provider-specific body built from the TYPED event — so the
   * one POST/timeout/non-2xx path is shared without round-tripping the event
   * through a JSON string (H6).
   */
  protected renderBody(event: NotifyEvent): string {
    return JSON.stringify(event);
  }
}

/** Default per-delivery timeout — a hung endpoint must not wedge the loop. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

/** Reject after `ms` so a never-resolving transport cannot hang forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`webhook delivery timed out after ${ms}ms`)),
      ms,
    );
    // Don't let the timer keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Strip any query/userinfo from a URL before logging — secrets ride in those. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<url>";
  }
}
