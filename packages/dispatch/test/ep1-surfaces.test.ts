import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "mcp-agent" };

function structured(result: {
  structuredContent: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent;
}

// --- MCP surface ------------------------------------------------------------

describe("EP-001 MCP: create_epic + add_dependency + get_ticket dependencies", () => {
  it("create_epic builds the node + dependency-ordered draft tickets", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    const res = structured(
      h.create_epic({
        epic: { name: "App", description: "build it" },
        tickets: [
          { title: "bootstrap", bootstrap: true, dependsOn: [] },
          { title: "feature", acceptanceCriteria: ["works"], dependsOn: [0] },
        ],
      }),
    );
    expect(res.epic_node_id).toBeTruthy();
    expect(res.ticket_numbers).toHaveLength(2);

    const numbers = res.ticket_numbers as number[];
    const feature = wg.resolveTicket(`#${numbers[1]}`);
    const ticketView = structured(h.get_ticket({ ticket_id: feature.id }));
    const deps = ticketView.dependencies as Array<{ satisfied: boolean }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]?.satisfied).toBe(false);
  });

  it("add_dependency tool gates a chosen ticket claim with DEPENDENCY_BLOCKED", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    const blocker = wg.createTicket({ title: "blocker" }, human);
    wg.addAcceptanceCriterion({ ticket_id: blocker.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(blocker.id, human);
    const dependent = wg.createTicket({ title: "dependent" }, human);
    wg.addAcceptanceCriterion({ ticket_id: dependent.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(dependent.id, human);

    const depRes = h.add_dependency({ ticket: dependent.id, depends_on: blocker.id });
    expect(depRes.isError).toBeUndefined();

    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    const claim = h.claim_ticket({
      ticket_id: dependent.id,
      agent_id: agent.id,
      ttl_seconds: 300,
    });
    expect(claim.isError).toBe(true);
    const err = (claim.structuredContent.error as { code: string }).code;
    expect(err).toBe("DEPENDENCY_BLOCKED");
  });
});

// --- REST surface -----------------------------------------------------------

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

describe("EP-001 REST: POST /epics + ticket dependencies", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /epics creates an epic and returns 201 with node id + ticket numbers", async () => {
    const res = await call(h.baseUrl, "POST", "/epics", {
      epic: { name: "Web app" },
      tickets: [
        { title: "bootstrap", bootstrap: true, dependsOn: [] },
        { title: "ui", dependsOn: [0] },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.epic_node_id).toBeTruthy();
    expect(res.body.ticket_numbers).toHaveLength(2);
  });

  it("POST /tickets/:id/dependencies adds an edge; GET lists it; DELETE removes it", async () => {
    const a = await call(h.baseUrl, "POST", "/tickets", { title: "A" });
    const b = await call(h.baseUrl, "POST", "/tickets", { title: "B" });
    const aId = (a.body.ticket as { id: string }).id;
    const bId = (b.body.ticket as { id: string }).id;

    const add = await call(h.baseUrl, "POST", `/tickets/${aId}/dependencies`, {
      depends_on: bId,
    });
    expect(add.status).toBe(201);
    expect(add.body.depends_on_ticket_id).toBe(bId);

    const list = await call(h.baseUrl, "GET", `/tickets/${aId}/dependencies`);
    expect(list.status).toBe(200);
    expect(list.body.dependencies).toHaveLength(1);

    const del = await call(h.baseUrl, "DELETE", `/tickets/${aId}/dependencies/${bId}`);
    expect(del.status).toBe(200);

    const after = await call(h.baseUrl, "GET", `/tickets/${aId}/dependencies`);
    expect(after.body.dependencies).toHaveLength(0);
  });

  it("GET /tickets/:id includes dependencies; a cyclic dependency is rejected 422", async () => {
    const a = await call(h.baseUrl, "POST", "/tickets", { title: "A" });
    const b = await call(h.baseUrl, "POST", "/tickets", { title: "B" });
    const aId = (a.body.ticket as { id: string }).id;
    const bId = (b.body.ticket as { id: string }).id;

    await call(h.baseUrl, "POST", `/tickets/${aId}/dependencies`, { depends_on: bId });
    // b -> a would close a cycle.
    const cyclic = await call(h.baseUrl, "POST", `/tickets/${bId}/dependencies`, {
      depends_on: aId,
    });
    expect(cyclic.status).toBe(422);
    expect((cyclic.body.error as { code: string }).code).toBe("INVALID_DEPENDENCY");

    const view = await call(h.baseUrl, "GET", `/tickets/${aId}`);
    expect(view.body.dependencies).toHaveLength(1);
  });
});
