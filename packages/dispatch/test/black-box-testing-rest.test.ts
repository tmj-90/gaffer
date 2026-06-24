import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(testingEnabled: boolean): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled });
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

/** Drive a fresh team_light ticket to `in_review` with a real delivery diff. */
function inReviewTicket(wg: Dispatch): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);
  giveTicketRealDelivery(wg, t.id, human);
  return t.id;
}

describe("BBT-001 REST surface", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("POST /tickets/:id/testable and /test-contract round-trip and surface on GET", async () => {
    h = await startHarness(true);
    const ticketId = inReviewTicket(h.wg);

    const testable = await call(h.baseUrl, "POST", `/tickets/${ticketId}/testable`, {
      can_be_tested: true,
    });
    expect(testable.status).toBe(200);
    expect(testable.body.canBeTested).toBe(true);

    const contract = await call(h.baseUrl, "POST", `/tickets/${ticketId}/test-contract`, {
      changed_surfaces: ["POST /api/widgets"],
      runtime_deps: ["Postgres 16"],
      env_vars: ["DATABASE_URL"],
      run_command: "docker compose up",
      harness_ready: false,
    });
    expect(contract.status).toBe(200);
    const written = contract.body.test_contract as { changed_surfaces: string[] };
    expect(written.changed_surfaces).toEqual(["POST /api/widgets"]);

    // GET ticket surfaces both new fields on the raw ticket row.
    const detail = await call(h.baseUrl, "GET", `/tickets/${ticketId}`);
    const ticket = detail.body.ticket as { can_be_tested: number; test_contract: string };
    expect(ticket.can_be_tested).toBe(1);
    expect(JSON.parse(ticket.test_contract).run_command).toBe("docker compose up");
  });

  it("approve routes to in_testing, then POST /tickets/:id/tester pass merges through", async () => {
    h = await startHarness(true);
    const ticketId = inReviewTicket(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/testable`, { can_be_tested: true });

    const approve = await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    expect(approve.status).toBe(200);
    expect((approve.body.ticket as { status: string }).status).toBe("in_testing");

    const pass = await call(h.baseUrl, "POST", `/tickets/${ticketId}/tester`, {
      verdict: "pass",
      summary: "all black-box tests pass",
    });
    expect(pass.status).toBe(200);
    expect((pass.body.ticket as { status: string }).status).toBe("ready_for_merge");
  });

  it("a tester FAIL via REST returns the ticket to refining", async () => {
    h = await startHarness(true);
    const ticketId = inReviewTicket(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/testable`, { can_be_tested: true });
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);

    const fail = await call(h.baseUrl, "POST", `/tickets/${ticketId}/tester`, {
      verdict: "fail",
      summary: "endpoint returns 500",
    });
    expect(fail.status).toBe(200);
    expect((fail.body.ticket as { status: string }).status).toBe("refining");
  });

  it("with the toggle OFF, approve skips the lane (straight to ready_for_merge)", async () => {
    h = await startHarness(false);
    const ticketId = inReviewTicket(h.wg);
    await call(h.baseUrl, "POST", `/tickets/${ticketId}/testable`, { can_be_tested: true });
    const approve = await call(h.baseUrl, "POST", `/tickets/${ticketId}/review/approve`);
    expect((approve.body.ticket as { status: string }).status).toBe("ready_for_merge");
  });
});
