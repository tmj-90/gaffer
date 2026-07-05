import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import type { PlanBuildRunner } from "../src/api/planBuild.js";
import { Dispatch } from "../src/core.js";
import { TestClock } from "../src/util/clock.js";

/**
 * Behavioural coverage for the OSS code-quality mediums fixed alongside the
 * dispatch god-file split:
 *   - M3: an unexpected internal error returns a FIXED generic 500 body and never
 *     leaks the underlying error message to the client.
 *   - M5: resource-creating 201 responses carry a `Location` header pointing at
 *     the created resource.
 */

let openServer: Server | null = null;
let openWg: Dispatch | null = null;

afterEach(async () => {
  if (openServer) {
    await new Promise<void>((resolve) => openServer!.close(() => resolve()));
    openServer = null;
  }
  if (openWg) {
    openWg.db.close();
    openWg = null;
  }
});

async function startServer(
  planBuildRunner?: PlanBuildRunner,
): Promise<{ baseUrl: string; wg: Dispatch }> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const noopPo = { run: () => ({ started: false, pid: null }) };
  // Default planBuildRunner is fine unless a test injects a throwing one.
  const server = planBuildRunner
    ? createApiServer(wg, noopPo, planBuildRunner)
    : createApiServer(wg, noopPo);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServer = server;
  openWg = wg;
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, wg };
}

describe("M3 — generic 500 never leaks the internal error message", () => {
  it("returns a fixed body when a handler throws an unexpected error", async () => {
    const SECRET = "SECRET_STACK_DETAIL_9f3a";
    const throwingRunner: PlanBuildRunner = {
      run: () => Promise.reject(new Error(SECRET)),
    };
    const { baseUrl } = await startServer(throwingRunner);

    const res = await fetch(`${baseUrl}/plan-build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "an app" }),
    });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected internal error occurred.");
  });
});

describe("M5 — 201 Created responses carry a Location header", () => {
  it("POST /tickets sets Location to the created ticket", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "M5 ticket" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: { id: string } };
    expect(res.headers.get("location")).toBe(`/tickets/${body.ticket.id}`);
  });

  it("POST /specs sets Location to the created spec", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "M5 spec" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { spec: { id: string } };
    expect(res.headers.get("location")).toBe(`/specs/${body.spec.id}`);
  });

  it("POST /scope/nodes sets Location to the created node", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/scope/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "M5 node", type: "product" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { id: string } };
    expect(res.headers.get("location")).toBe(`/scope/nodes/${body.node.id}`);
  });

  it("POST /decisions sets Location to the created decision", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "M5 decision", question: "Ship it?" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { decision: { id: string } };
    expect(res.headers.get("location")).toBe(`/decisions/${body.decision.id}`);
  });

  it("POST /plan-sessions sets Location to the created session", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/plan-sessions`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string } };
    expect(res.headers.get("location")).toBe(`/plan-sessions/${body.session.id}`);
  });
});
