// Shared test-infra teardown for the web dashboard DOM tests.
//
// The web tests boot the whole SPA (src/api/web/app.js), which starts
// long-lived pollers via setInterval (autoRefresh, liveTick, ticket detail,
// PR watch) and one-shot setTimeout timers (toast, debounce, focus, boot
// class removal). The tests never clear these, so a timer can fire after
// JSDOM has been torn down. Vitest 3 is stricter than 2 and fails the whole
// run with: "This error was caught after test environment was torn down ...
// cancel timeouts using clearTimeout and clearInterval".
//
// Fix: transparently record every live timer handle and clear whatever is
// still pending in a global afterEach. This runs with REAL timers, so the
// tests' `tick = () => new Promise(r => setTimeout(r, 0))` helper keeps
// working unchanged (those timers resolve during the test and are cleared
// from the registry on fire). We only delegate to the platform timers and
// track handles — no behavior, timing, or fetch mocking is affected.

import { afterEach } from "vitest";

const g = globalThis as typeof globalThis;

const originalSetTimeout = g.setTimeout.bind(g);
const originalSetInterval = g.setInterval.bind(g);
const originalClearTimeout = g.clearTimeout.bind(g);
const originalClearInterval = g.clearInterval.bind(g);

// setTimeout/setInterval return NodeJS.Timeout under @types/node but a numeric id
// under the DOM lib. typecheck:test runs under the jsdom test config where the calls
// resolve to `number`, so type handles as number and tracking + clearing typecheck
// cleanly (clearTimeout/clearInterval accept the numeric id).
type TimerHandle = number;

const pendingTimeouts = new Set<TimerHandle>();
const pendingIntervals = new Set<TimerHandle>();

// Wrap setTimeout so single-shot timers are tracked until they fire (at which
// point they self-remove) or are cleared. We wrap the callback rather than
// leaving the handle in the set forever so the registry stays small and a
// fired-then-recreated handle id can't be spuriously cleared.
g.setTimeout = function trackedSetTimeout(
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): TimerHandle {
  const wrapped =
    typeof handler === "function"
      ? (...cbArgs: unknown[]) => {
          pendingTimeouts.delete(handle);
          return (handler as (...a: unknown[]) => unknown)(...cbArgs);
        }
      : handler;
  const handle: TimerHandle = originalSetTimeout(wrapped as TimerHandler, timeout, ...args);
  pendingTimeouts.add(handle);
  return handle;
} as unknown as typeof g.setTimeout;

g.setInterval = function trackedSetInterval(
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): TimerHandle {
  const handle = originalSetInterval(handler, timeout, ...args);
  pendingIntervals.add(handle);
  return handle;
} as unknown as typeof g.setInterval;

g.clearTimeout = function trackedClearTimeout(handle?: TimerHandle): void {
  if (handle !== undefined) pendingTimeouts.delete(handle);
  originalClearTimeout(handle);
} as unknown as typeof g.clearTimeout;

g.clearInterval = function trackedClearInterval(handle?: TimerHandle): void {
  if (handle !== undefined) pendingIntervals.delete(handle);
  originalClearInterval(handle);
} as unknown as typeof g.clearInterval;

afterEach(() => {
  for (const handle of pendingIntervals) originalClearInterval(handle);
  for (const handle of pendingTimeouts) originalClearTimeout(handle);
  pendingIntervals.clear();
  pendingTimeouts.clear();
});
