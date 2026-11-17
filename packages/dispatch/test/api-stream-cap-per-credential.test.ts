/**
 * EVENT STREAM CAP PER CREDENTIAL (sec-authz-2 F5). The cap on concurrent
 * /api/events/stream connections was one global 16, so a holder of the derived read
 * token (the one handed to phones) or of any principal token could open 16 streams and
 * starve the operator's live feed. Now each credential has its own cap, everyone but
 * the operator shares a ceiling, and the shared full token keeps its own slots.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { deriveReadToken, setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer, endEventStreams } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

// The caps (routes/api.ts STREAM_MAX_*), as literals so this file also runs against the
// code before the change and shows what it did.
const STREAM_MAX_OPERATOR = 16;
const STREAM_MAX_PER_CREDENTIAL = 4;
const STREAM_MAX_OTHERS = 16;
const FULL = "shared-full-token-for-stream-cap-tests-0123456789";
const human: Actor = { type: "human", id: "tom" };

const saved = process.env.DISPATCH_API_TOKEN;
const aborts: AbortController[] = [];
// Every open stream's Response is held until the test ends. fetch cancels the body of a
// Response that is garbage-collected, which closes the connection and frees its slot on
// the server: a collection in the middle of a test then let one stream more than the cap
// through (seen once on a macOS CI runner: "expected 200 to be 503").
const held: Response[] = [];
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  held.length = 0;
  endEventStreams("test over");
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

async function start() {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        wg.db.close();
        resolve();
      });
    });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Open a stream and keep it open; resolves to the status. */
  const open = async (token: string): Promise<number> => {
    const ac = new AbortController();
    aborts.push(ac);
    const res = await fetch(`${base}/api/events/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    if (res.status !== 200) await res.text();
    else held.push(res);
    return res.status;
  };
  return { wg, open };
}

describe("F5: the event stream cap is per credential", () => {
  it("the read token cannot starve the operator", async () => {
    const { open } = await start();
    const read = deriveReadToken(FULL);
    for (let i = 0; i < STREAM_MAX_PER_CREDENTIAL; i++) expect(await open(read)).toBe(200);
    expect(await open(read)).toBe(503);
    expect(await open(FULL)).toBe(200);
  });

  it("all other credentials together cannot starve the operator", async () => {
    const { wg, open } = await start();
    const principals = Array.from(
      { length: Math.ceil(STREAM_MAX_OTHERS / STREAM_MAX_PER_CREDENTIAL) + 1 },
      (_, i) =>
        wg.createPrincipal({ name: `p${i}`, capability: "read", actorType: "human" }, human).token,
    );
    let opened = 0;
    for (const p of principals) {
      for (let i = 0; i < STREAM_MAX_PER_CREDENTIAL; i++) {
        const status = await open(p);
        if (opened < STREAM_MAX_OTHERS) {
          expect(status).toBe(200);
          opened += 1;
        } else expect(status).toBe(503);
      }
    }
    // The ceiling is reached, yet the operator keeps every one of its own slots.
    for (let i = 0; i < STREAM_MAX_OPERATOR; i++) expect(await open(FULL)).toBe(200);
    expect(await open(FULL)).toBe(503);
  }, 20_000);
});
