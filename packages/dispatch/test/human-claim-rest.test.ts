// TRACK-2b REST surface: the human WIP lane over HTTP.
//   POST /tickets/:id/human-claim  → take a ready ticket by hand (in_progress, human)
//   POST /tickets/:id/human-release → hand it back to the queue (ready)

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
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function readyTicket(wg: Dispatch): string {
  const t = wg.createTicket({ title: "Task", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  return t.id;
}

describe("TRACK-2b REST: human-claim / human-release", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /tickets/:id/human-claim takes the ticket by hand", async () => {
    const id = readyTicket(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/human-claim`, {});
    expect(res.status).toBe(200);
    expect(res.body.human_owned).toBe(true);
    expect(h.wg.view(id).ticket.status).toBe("in_progress");
    expect(h.wg.view(id).ticket.human_owner).toBe("dispatch-api");
  });

  it("POST /tickets/:id/human-claim on a non-ready ticket 409s", async () => {
    const id = readyTicket(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${id}/human-claim`, {}); // now in_progress
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/human-claim`, {});
    expect(res.status).toBe(409);
  });

  it("POST /tickets/:id/human-release hands it back to ready", async () => {
    const id = readyTicket(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${id}/human-claim`, {});
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/human-release`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(h.wg.view(id).ticket.human_owner).toBeNull();
  });

  it("POST /tickets/:id/human-release on non-human-owned work 409s", async () => {
    const id = readyTicket(h.wg);
    const res = await call(h.baseUrl, "POST", `/tickets/${id}/human-release`, {});
    expect(res.status).toBe(409);
  });
});
