/**
 * The dashboard (app.js in JSDOM) talking to a REAL API server, for the DOM tests that
 * drive the Review view end to end.
 *
 * THE SIGNAL. The SPA passes `{ signal: routeSignal() }` on its route-scoped requests
 * (the diff among them). Under vitest's jsdom environment that AbortSignal is JSDOM's,
 * and Node 24's fetch (undici) refuses any signal that is not its own ("RequestInit:
 * Expected signal to be an instance of AbortSignal"); Node 22's accepted it. So on the
 * CI's Node 24 every diff request rejected, the sign-off never got its approve_outcome
 * and the tests waited out their cap. The stub keeps the signal away from Node's fetch
 * and honours it itself: a request whose route was left still rejects with the reason.
 *
 * THE LOG. Every request the page makes is recorded (path, status or error, and for a
 * diff the approve_outcome kind), so a wait that times out can say what the view saw.
 */

export interface FetchLogEntry {
  method: string;
  path: string;
  /** The HTTP status, or null while pending / when the request rejected. */
  status: number | null;
  /** Why the request rejected, or null. */
  error: string | null;
  /** A diff response's approve_outcome kind: undefined until read, null when absent. */
  approveOutcome?: string | null;
}

const abortError = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });

/** A fetch for the page: relative paths go to `base`, through `realFetch`, logged. */
export function realServerFetch(
  base: string,
  realFetch: typeof fetch,
  log: FetchLogEntry[] = [],
): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  log: FetchLogEntry[];
} {
  const stub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = String(input);
    const url = /^https?:/.test(raw) ? raw : base + raw;
    const entry: FetchLogEntry = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: raw.startsWith(base) ? raw.slice(base.length) : raw,
      status: null,
      error: null,
    };
    log.push(entry);
    const signal = init?.signal ?? null;
    const rest: RequestInit = { ...init };
    delete rest.signal;
    const call = realFetch(url, rest).then(
      (res) => {
        entry.status = res.status;
        if (/\/diff(\?|$)/.test(entry.path))
          void res
            .clone()
            .json()
            .then(
              (j: { approve_outcome?: { kind?: string } | null }) =>
                (entry.approveOutcome = j?.approve_outcome?.kind ?? null),
              () => (entry.approveOutcome = null),
            );
        return res;
      },
      (e: unknown) => {
        entry.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        throw e;
      },
    );
    if (!signal) return call;
    if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
  return { fetch: stub, log };
}

/**
 * Poll `cond` until it holds, generously (a loaded CI runner shares 2 vCPUs among the
 * vitest workers), then fail naming `label` and what `diagnose` reports.
 */
export async function waitUntil(
  cond: () => boolean,
  label: string,
  diagnose: () => string,
  { timeoutMs = 30_000, everyMs = 50 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`${label}: not within ${timeoutMs} ms\n  ${diagnose()}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const text = (n: Element | null | undefined, max = 200): string =>
  JSON.stringify((n?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max));

/** What the Review view shows and what its requests got: the failure message's body. */
export function reviewViewState(log: readonly FetchLogEntry[]): string {
  const fmt = (e: FetchLogEntry) =>
    `${e.method} ${e.path} → ${e.status ?? (e.error ? "rejected" : "no response yet")}` +
    (e.error ? ` (${e.error})` : "");
  const diffs = log.filter((e) => /\/diff(\?|$)/.test(e.path));
  const outcome = diffs.length
    ? diffs
        .map((e) => (e.approveOutcome === undefined ? "not read" : (e.approveOutcome ?? "absent")))
        .join(", ")
    : "no diff response";
  const toast = document.getElementById("toast");
  const next = document.querySelector(".signoff-next");
  const btn = document.querySelector("button.signoff-btn") as HTMLButtonElement | null;
  const failed = log.filter((e) => e.error || (e.status !== null && e.status >= 400));
  return [
    `route: ${location.hash}`,
    `diff request: ${diffs.length ? diffs.map(fmt).join("; ") : "never sent"}`,
    `approve_outcome: ${outcome}`,
    `toast: ${toast && !toast.hidden ? text(toast) : "none"}`,
    `sign-off line: ${next ? (next.hasAttribute("hidden") ? "hidden" : text(next)) : "absent"}`,
    `sign-off button: ${btn ? `${text(btn)}${btn.disabled ? " (disabled)" : ""} class="${btn.className}"` : "absent"}`,
    `diff box: ${text(document.querySelector(".diff-box"))}`,
    `failed requests: ${failed.length ? `${failed.length}, first: ${failed.slice(0, 3).map(fmt).join("; ")}` : "none"}`,
    `requests: ${log.length} (${log.filter((e) => e.status === null && !e.error).length} pending)`,
  ].join("\n  ");
}
