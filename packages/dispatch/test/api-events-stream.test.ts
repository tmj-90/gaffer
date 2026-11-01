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

import { setPrincipalResolver } from "../src/api/auth.js";
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

  it("?since beyond the latest seq resets to the latest, says so in a reset frame, and then streams (exploratory finding api-robustness/F13)", async () => {
    // A cursor from before a restore/import (or a typo) used to open ": connected
    // seq=<since>" and then stay silent forever: every new seq was below the cursor.
    h.wg.createTicket({ title: "A" }, human);
    const latest = h.wg.events.latestSeq();
    const ctrl = new AbortController();
    const res = await fetch(`${h.baseUrl}/api/events/stream?since=${latest + 500}`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    setTimeout(() => h.wg.createTicket({ title: "B" }, human), 50);
    const frames = await readFrames(res, 2);
    const reset = frames.find((f) => f.event === "reset");
    expect(reset).toBeDefined();
    expect(reset!.id).toBe(latest);
    expect(reset!.data).toMatchObject({ requested: latest + 500, latest });
    const ev = frames.find((f) => f.event === "work_event");
    expect(ev, "a new event still arrives after the reset").toBeDefined();
    expect(ev!.id!).toBeGreaterThan(latest);
    ctrl.abort();
  });

  it("a malformed ?since is a 422, not a silent default", async () => {
    for (const bad of ["abc", "-1", "1.5"]) {
      const res = await fetch(`${h.baseUrl}/api/events/stream?since=${bad}`);
      expect(res.status, bad).toBe(422);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("VALIDATION_ERROR");
    }
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

describe("GET /api/events/stream ends when its credential is revoked", () => {
  const FULL = "shared-full-token-for-stream-revocation-0123456789";
  const prev = process.env.DISPATCH_API_TOKEN;
  let h: Harness;
  beforeEach(async () => {
    process.env.DISPATCH_API_TOKEN = FULL;
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    setPrincipalResolver(null);
    if (prev === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = prev;
  });
  const open = (token: string, signal: AbortSignal) =>
    fetch(`${h.baseUrl}/api/events/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });

  it("a revoked principal's open stream closes without delivering later events", async () => {
    const { token } = h.wg.createPrincipal({ name: "viewer2", capability: "read" }, human);
    const ctrl = new AbortController();
    const res = await open(token, ctrl.signal);
    expect(res.status).toBe(200);
    h.wg.revokePrincipal("viewer2", human);
    h.wg.createTicket({ title: "after revoke" }, human);
    const frames = await readFrames(res, 1, 3500);
    expect(frames.some((f) => f.event === "auth_revoked")).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("after revoke");
    ctrl.abort();
  });

  it("the shared token's stream keeps delivering after an unrelated principal is revoked", async () => {
    h.wg.createPrincipal({ name: "other" }, human);
    const ctrl = new AbortController();
    const res = await open(FULL, ctrl.signal);
    h.wg.revokePrincipal("other", human);
    h.wg.createTicket({ title: "still streamed" }, human);
    const frames = await readFrames(res, 1);
    expect(frames.some((f) => f.data?.ticket_title === "still streamed")).toBe(true);
    ctrl.abort();
  });
});
