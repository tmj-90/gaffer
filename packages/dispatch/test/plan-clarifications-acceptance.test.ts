/**
 * PLANNING CLARIFICATIONS → ACCEPTANCE CONTRACT.
 *
 * A canned plan session (through the plan-sessions API): the brief is "a link
 * shortener", the planner asks "How long should a link live?", the human answers
 * "Links expire after 30 minutes". The planner's proposed tickets then omit expiry.
 * Confirming used to keep only the brief, so the acceptance ticket had no expiry
 * criterion and the independent tester never heard of it. Now the confirmed epic's
 * acceptance ticket carries every agreed requirement as a criterion, whether the
 * client sends them (its reviewed list) or names the session.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import {
  agreedRequirementsFromTurns,
  criterionCovers,
  uncoveredRequirements,
} from "../src/util/planClarifications.js";
import { TestClock } from "../src/util/clock.js";

const QUESTION = "How long should a shortened link stay valid?";
const ANSWER = "Links expire after 30 minutes";
const PLAN = {
  epic: { name: "Shortener", description: "A link shortener" },
  tickets: [
    {
      title: "Shorten a URL",
      description: "POST /links returns a short code",
      acceptanceCriteria: ["POST /links returns a short code", "GET /:code redirects to the URL"],
      dependsOn: [],
    },
  ],
};

async function start(): Promise<{ base: string; wg: Dispatch; close: () => Promise<void> }> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    wg,
    close: () => new Promise<void>((r) => server.close(() => (wg.db.close(), r()))),
  };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A canned clarification session: brief → planner question → the human's answer → plan. */
async function cannedSession(base: string): Promise<string> {
  const created = await call(base, "POST", "/plan-sessions");
  const id = (created.body.session as { id: string }).id;
  await call(base, "POST", `/plan-sessions/${id}/turns`, {
    role: "user",
    content: "a link shortener",
    brief: "a link shortener",
  });
  await call(base, "POST", `/plan-sessions/${id}/turns`, {
    role: "assistant",
    content: JSON.stringify({ phase: "clarify", questions: [QUESTION] }),
  });
  await call(base, "POST", `/plan-sessions/${id}/turns`, { role: "user", content: ANSWER });
  await call(base, "POST", `/plan-sessions/${id}/turns`, {
    role: "assistant",
    content: JSON.stringify({ phase: "plan", plan: PLAN }),
    plan: PLAN,
  });
  return id;
}

function acceptanceCriteria(wg: Dispatch, n: number): string[] {
  const t = wg.resolveTicket(String(n));
  return wg.acs.listForTicket(t.id).map((a) => a.text);
}

describe("clarification answers reach the acceptance contract", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("POST /epics with the plan session id → the acceptance ticket has the agreed requirement", async () => {
    const s = await start();
    close = s.close;
    const id = await cannedSession(s.base);
    const res = await call(s.base, "POST", "/epics", {
      ...PLAN,
      epic: { ...PLAN.epic, brief: "a link shortener" },
      plan_session_id: id,
    });
    expect(res.status).toBe(201);
    expect(res.body.agreed_requirements).toBe(1);
    const acc = res.body.acceptance_ticket_number as number;
    const criteria = acceptanceCriteria(s.wg, acc);
    const agreed = criteria.filter((c) => c.startsWith("Agreed during planning:"));
    expect(agreed).toEqual([`Agreed during planning: ${ANSWER} (in answer to: "${QUESTION}")`]);
    // The implementation ticket the planner proposed is unchanged (no expiry there).
    const impl = (res.body.ticket_numbers as number[])[0]!;
    expect(acceptanceCriteria(s.wg, impl).some((c) => /30/.test(c))).toBe(false);
    // The acceptance description states it too (the tester's packet carries both).
    const desc = s.wg.resolveTicket(String(acc)).description;
    expect(desc).toContain("Requirements agreed during planning");
    expect(desc).toContain(ANSWER);
  });

  it("an explicit (human-reviewed) list wins over the session", async () => {
    const s = await start();
    close = s.close;
    const id = await cannedSession(s.base);
    const res = await call(s.base, "POST", "/epics", {
      ...PLAN,
      epic: { ...PLAN.epic, agreed_requirements: [] },
      plan_session_id: id,
    });
    expect(res.status).toBe(201);
    expect(res.body.agreed_requirements).toBe(0);
  });

  it("an unknown plan session is refused (the answers cannot be found)", async () => {
    const s = await start();
    close = s.close;
    const res = await call(s.base, "POST", "/epics", { ...PLAN, plan_session_id: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("planClarifications helpers", () => {
  it("pairs each answer with the clarify turn before it; the brief is not an answer", () => {
    const got = agreedRequirementsFromTurns([
      { role: "user", content: "a link shortener" },
      { role: "assistant", content: JSON.stringify({ phase: "clarify", questions: ["Q1", "Q2"] }) },
      { role: "user", content: "  answer one  " },
      { role: "assistant", content: JSON.stringify({ phase: "plan", plan: {} }) },
      { role: "user", content: "not an answer" },
    ]);
    expect(got).toEqual([{ question: "Q1 Q2", answer: "answer one" }]);
  });
  it("a criterion without the number does not cover a numeric requirement", () => {
    expect(criterionCovers("Short links expire", ANSWER)).toBe(false);
    expect(criterionCovers("Links expire 30 minutes after creation", ANSWER)).toBe(true);
    expect(
      uncoveredRequirements([{ answer: ANSWER }], PLAN.tickets[0]!.acceptanceCriteria),
    ).toHaveLength(1);
  });
});
