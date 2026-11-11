import { scrubMessage, urlOrigin } from "../redactUrl.js";
import type { HttpTransport, NotifyEvent, NotifySink } from "../types.js";

/**
 * The default HTTP transport: the platform `fetch`. Wrapped so the sink only
 * depends on the {@link HttpTransport} slice and tests can swap a fake in. Node
 * 20+ (the engine floor) ships a global `fetch`, so no dependency is needed.
 */
const fetchTransport: HttpTransport = async (url, init) => {
  // Never follow a redirect: a 3xx could move the POST (and its body) to a host the
  // URL policy would have refused. The 3xx comes back as a non-2xx answer, so the sink
  // reports it as a failed delivery by origin and status; the Location is never read.
  const res = await fetch(url, { ...init, redirect: "manual" });
  // The body is never read; cancel it so the connection is released at once.
  await res.body?.cancel().catch(() => undefined);
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
    // The URL is a credential (Slack keeps its secret in the path): every message this
    // sink produces names it by its ORIGIN only (see ../redactUrl.ts).
    const where = urlOrigin(this.url);
    const controller = new AbortController();
    let res: { ok: boolean; status: number };
    try {
      res = await withTimeout(
        () =>
          this.transport(this.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: this.renderBody(event),
            signal: controller.signal,
          }),
        this.timeoutMs,
        // At the deadline the request itself is aborted, not only abandoned: a hung
        // endpoint must not keep a socket open behind a promise nobody awaits.
        () => controller.abort(),
        `webhook POST to ${where} timed out after ${this.timeoutMs}ms`,
      );
    } catch (err) {
      if (err instanceof WebhookTimeoutError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // The transport's error is deliberately NOT attached as `cause`: its message and
      // its own cause can quote the URL (a fetch error does), and a logger that prints
      // the cause chain would put the credential back in the log.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `webhook POST to ${where} failed: ${scrubMessage(message, this.url)}${causeCode(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`webhook POST to ${where} returned ${res.status}`);
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

class WebhookTimeoutError extends Error {}

/**
 * Run `start()` and reject after `ms` so a never-resolving transport cannot hang
 * forever; `onTimeout` runs at the deadline (it aborts the request). A transport that
 * ignores the abort signal still times out, as before.
 */
function withTimeout<T>(
  start: () => Promise<T>,
  ms: number,
  onTimeout: () => void,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new WebhookTimeoutError(timeoutMessage));
      onTimeout();
    }, ms);
    // Don't let the timer keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (!settled) resolvePromise(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** ` (ECONNREFUSED)` from a fetch error's cause, when it has a plain error code. */
function causeCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause && typeof cause.code === "string" ? cause.code : "";
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
}
