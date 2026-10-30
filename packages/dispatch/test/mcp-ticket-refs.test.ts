import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers, type Handlers, type ToolResult } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

/**
 * Every ticket-taking MCP tool accepts the same references: the id, `N`, `#N` and
 * `T-N`. add_acceptance_criterion, mark_ticket_blocked and submit_ticket_for_review
 * used a bare id lookup, so an agent passing the `#N` its prompt names was told its
 * own claimed ticket did not exist — including on its block escape hatch.
 */

const human: Actor = { type: "human", id: "alice" };
const agent: Actor = { type: "agent", id: "mcp-agent" };

interface Seed {
  wg: Dispatch;
  h: Handlers;
  id: string;
  token: string;
  otherId: string;
}

/** Ticket #1 claimed by the agent (token in hand) + a ready #2 to depend on. */
function seed(): Seed {
  const wg = Dispatch.open(":memory:", new TestClock());
  const t = wg.createTicket({ title: "one", description: "", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
  wg.registerRepository({ name: "app", path: "/tmp/app" }, human);
  wg.linkRepository(t.id, "app", "primary", human);
  wg.markReady(t.id, human);
  const other = wg.createTicket(
    { title: "two", description: "", policy_pack: "solo_loose" },
    human,
  );
  const a = wg.registerAgent({ display_name: "c" }, human);
  const claim = wg.claimTicket({ ticket_id: t.id, agent_id: a.id, ttl_seconds: 600 }, agent);
  return { wg, h: makeHandlers(wg, agent), id: t.id, token: claim.claimToken, otherId: other.id };
}

const TOOLS: Array<[string, (s: Seed, ref: string) => ToolResult, boolean]> = [
  // [tool, call, returns ticket_id]
  ["get_ticket", (s, ref) => s.h.get_ticket({ ticket_id: ref }), false],
  [
    "add_acceptance_criterion",
    (s, ref) => s.h.add_acceptance_criterion({ ticket_id: ref, text: "more" }),
    false,
  ],
  [
    "record_ac_evidence",
    (s, ref) =>
      s.h.record_ac_evidence({
        claim_token: s.token,
        ticket_id: ref,
        evidence_type: "manual_note",
        summary: "s",
      }),
    false,
  ],
  [
    "record_delivery_artifact",
    (s, ref) =>
      s.h.record_delivery_artifact({ claim_token: s.token, ticket_id: ref, branch_name: "b" }),
    true,
  ],
  [
    "record_repo_delivery",
    (s, ref) =>
      s.h.record_repo_delivery({ ticket_id: ref, repo_id: "app", status: "changes_made" }),
    true,
  ],
  [
    "set_ticket_testable",
    (s, ref) => s.h.set_ticket_testable({ ticket_id: ref, can_be_tested: true }),
    true,
  ],
  [
    "set_test_contract",
    (s, ref) => s.h.set_test_contract({ ticket_id: ref, run_command: "npm start" }),
    true,
  ],
  ["add_dependency", (s, ref) => s.h.add_dependency({ ticket: s.otherId, depends_on: ref }), false],
  [
    "request_decision",
    (s, ref) => s.h.request_decision({ title: "t", question: "q", ticket_id: ref }),
    false,
  ],
  [
    "mark_ticket_blocked",
    (s, ref) => s.h.mark_ticket_blocked({ claim_token: s.token, ticket_id: ref, reason: "stuck" }),
    true,
  ],
  [
    "submit_ticket_for_review",
    (s, ref) => s.h.submit_ticket_for_review({ claim_token: s.token, ticket_id: ref }),
    true,
  ],
];

describe("MCP ticket references are accepted uniformly", () => {
  for (const [tool, call, returnsId] of TOOLS) {
    for (const ref of ["1", "#1", "T-1", "uuid"]) {
      it(`${tool} accepts ${ref === "uuid" ? "the id" : `'${ref}'`}`, () => {
        const s = seed();
        const r = call(s, ref === "uuid" ? s.id : ref);
        expect(r.structuredContent.error).toBeUndefined();
        if (returnsId) expect(r.structuredContent.ticket_id).toBe(s.id);
      });
    }
  }

  it("an unknown reference is still NOT_FOUND", () => {
    const s = seed();
    const r = s.h.mark_ticket_blocked({ claim_token: s.token, ticket_id: "#99", reason: "x" });
    expect((r.structuredContent.error as { code: string }).code).toBe("NOT_FOUND");
  });
});
