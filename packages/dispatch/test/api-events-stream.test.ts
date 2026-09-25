/**
 * GET /api/events/stream — the live push of the append-only event log as
 * Server-Sent Events, replacing the dashboard's blind interval polling.
 *
 *   - streams NEW work events as `id:` / `event: work_event` / `data:` frames with
 *     the metadata-only activity shape (never payload_json);
 *   - `?since=<seq>` replays from a cursor (0 ⇒ the whole log), default ⇒ only new;
 *   - sits behind the bearer gate like every data route (401 without the token);
 *   - the stream ends cleanly when the client disconnects.
 */
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

interface Frame {
  id?: number;
  event?: string;
  data?: Record<string, unknown>;
}

/** Read SSE frames from a response body until `want` frames with `event:` arrive or the deadline passes. */
async function readFrames(res: Response, want: number, deadlineMs = 4000): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + deadlineMs;
  while (frames.filter((f) => f.event).length < want && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const f: Frame = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith("id: ")) f.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("data: "))
          f.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
      }
      frames.push(f);
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

describe("GET /api/events/stream (SSE)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("pushes a new work event as an SSE frame with the metadata-only activity shape", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.baseUrl}/api/events/stream`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Fire an event AFTER the stream is open — the default cursor starts at "now".
    const t = h.wg.createTicket({ title: "Streamed ticket <script>" }, human);

    const frames = await readFrames(res, 1);
    const ev = frames.find((f) => f.event === "work_event");
    expect(ev).toBeDefined();
    expect(typeof ev!.id).toBe("number");
    expect(ev!.data).toMatchObject({
      entity_type: "ticket",
      entity_id: t.id,
      ticket_number: t.number,
      ticket_title: "Streamed ticket <script>",
      actor_type: "human",
    });
    expect(ev!.data).toHaveProperty("event_type");
    expect(ev!.data).toHaveProperty("seq");
    // Metadata only — the free-text payload never rides the stream.
    expect(ev!.data).not.toHaveProperty("payload_json");
    expect(ev!.data).not.toHaveProperty("payload");
    ctrl.abort();
  });

  it("?since=0 replays the whole log from the start; ?since=<seq> resumes after it", async () => {
    h.wg.createTicket({ title: "A" }, human);
    h.wg.createTicket({ title: "B" }, human);
    const ctrl = new AbortController();
    const res = await fetch(`${h.baseUrl}/api/events/stream?since=0`, { signal: ctrl.signal });
    const frames = await readFrames(res, 2);
    const evs = frames.filter((f) => f.event === "work_event");
    expect(evs.length).toBeGreaterThanOrEqual(2);
    const ids = evs.map((f) => f.id!);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // ascending seq
    ctrl.abort();

    // Resume strictly after the last seen seq: only later events arrive.
    const last = ids[ids.length - 1]!;
    const ctrl2 = new AbortController();
    const res2 = await fetch(`${h.baseUrl}/api/events/stream?since=${last}`, {
      signal: ctrl2.signal,
    });
    h.wg.createTicket({ title: "C" }, human);
    const frames2 = await readFrames(res2, 1);
    const evs2 = frames2.filter((f) => f.event === "work_event");
    expect(evs2.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...evs2.map((f) => f.id!))).toBeGreaterThan(last);
    ctrl2.abort();
  });

  it("is behind the bearer gate: 401 without the token when auth is configured", async () => {
    const prev = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "secret-token-for-stream-test";
    try {
      const anon = await fetch(`${h.baseUrl}/api/events/stream`);
      expect(anon.status).toBe(401);
      const ctrl = new AbortController();
      const ok = await fetch(`${h.baseUrl}/api/events/stream`, {
        headers: { authorization: "Bearer secret-token-for-stream-test" },
        signal: ctrl.signal,
      });
      expect(ok.status).toBe(200);
      ctrl.abort();
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = prev;
    }
  });

  it("rejects non-GET", async () => {
    const res = await fetch(`${h.baseUrl}/api/events/stream`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
