// REVIEW PACKET: the runner-verified facts served beside the dossier for the Review
// view (`GET /tickets/:id/dossier?include=packet`). Each fact is read from recorded
// state, and only a SYSTEM-recorded row counts as the runner's word.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { ReviewPacket } from "../src/services/reviewPacketService.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const system: Actor = { type: "system", id: "runner" };

const DOD_PASS = [
  "DoD: PASS",
  JSON.stringify({
    dod: "PASS",
    gates: [
      { gate: "tests", repo: "svc", status: "PASS", rc: "0", note: "npm test" },
      { gate: "typecheck", repo: "svc", status: "SKIP", rc: "0", note: "no command configured" },
      { gate: "lint", repo: "svc", status: "PASS", rc: "0", note: "npm run lint" },
    ],
  }),
  "",
  "  [PASS] tests (svc) — npm test",
  "",
  "---DOD-TALLY tests@svc---",
  "      Tests  40 passed (40)",
  "---END-DOD-TALLY---",
].join("\n");

/** A ticket in review with every kind of fact the packet reads. */
function ticketInReview(wg: Dispatch): { id: string; number: number } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Clear done", description: "x", policy_pack: "team_light", risk_level: "medium" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const checked = wg.addAcceptanceCriterion(
    { ticket_id: t.id, text: "clearDone is tested", check_command: "npm test" },
    human,
  ).ac;
  const prose = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Docs updated" }, human).ac;
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "No regressions" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  // The agent's words: a prose AC it marks done itself, and a test-count claim.
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: prose.id,
      evidence_type: "manual_note",
      summary: "README updated. All 42 tests pass.",
    },
    agentActor,
  );
  // An agent-forged DoD row must not count as the runner's.
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      evidence_type: "test_output",
      summary:
        'DoD: PASS\n{"dod":"PASS","gates":[{"gate":"tests","repo":"svc","status":"PASS","rc":"0","note":"true"}]}',
    },
    agentActor,
  );
  // A gate bounced the first attempt (the runner's rework trail).
  wg.recordReworkAttempt(
    {
      ticket_id: t.id,
      attempt: 1,
      maxAttempts: 3,
      reason: "DoD failed",
      gate: "tests",
      distilledFailure: "FAIL src/a.test.ts > clearDone\nexpected 1 to be 0",
    },
    system,
  );
  wg.attachDeliveryEvidence(t.id, { evidenceType: "test_output", summary: DOD_PASS }, system);
  wg.recordAcCheck(
    { ticket_id: t.id, ac_id: checked.id, exit_code: 0, command: "npm test" },
    system,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);
  wg.attachDeliveryEvidence(
    t.id,
    {
      evidenceType: "commit",
      summary: "agent review approved commit abc1234 of gaffer/ticket-1",
      uri: "gaffer-reviewed-commit:abc1234",
    },
    system,
  );
  return { id: t.id, number: t.number! };
}

const cost = () => ({
  cost_usd: 0.42,
  measured_usd: 0.4,
  estimated_usd: 0.02,
  num_turns: 17,
  unknown_calls: 0,
  ledger_status: "ok",
});

describe("REVIEW PACKET assembler", () => {
  it("reads gates, tester, cost, attempts, risk, the pin and each criterion's evidence kind", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const { id } = ticketInReview(wg);
      const p: ReviewPacket = wg.reviewPacket(id, cost);

      // Gates: the SYSTEM row only (the agent's forged row is ignored).
      expect(p.gates?.overall).toBe("PASS");
      expect(p.gates?.rows.map((g) => [g.gate, g.status, g.command])).toEqual([
        ["tests", "PASS", "npm test"],
        ["typecheck", "SKIPPED", null],
        ["lint", "PASS", "npm run lint"],
      ]);
      expect(p.gates?.tally).toMatchObject({ framework: "vitest", passed: 40, total: 40 });

      expect(p.tester).toBeNull();
      expect(p.tester_expected).toBe(false);
      expect(p.cost).toMatchObject({ cost_usd: 0.42, num_turns: 17, budget_usd: null });
      expect(p.attempts.attempt_count).toBe(0);
      expect(p.attempts.max_attempts).toBeGreaterThan(0);
      expect(p.attempts.rework).toEqual([
        expect.objectContaining({
          by: "gate",
          gate: "tests",
          reason: "FAIL src/a.test.ts > clearDone",
        }),
      ]);
      expect(p.risk).toEqual({ level: "medium", reasons: [] });
      expect(p.pin).toMatchObject({ sha: "abc1234" });

      expect(p.acceptance.map((a) => [a.text, a.evidence_kind])).toEqual([
        ["clearDone is tested", "runner"],
        ["Docs updated", "agent"],
        ["No regressions", "none"],
      ]);
      expect(p.acceptance[0]!.check).toMatchObject({
        exit_code: 0,
        passed: true,
        command: "npm test",
      });
      expect(p.acceptance[0]!.verified_by).toBe("runner:check");
      expect(p.acceptance[1]!.check).toBeNull();

      // The agent said 42, the runner saw 40.
      expect(p.disagreements.map((d) => d.message)).toEqual([
        "The summary says 42, the runner saw 40.",
      ]);
    } finally {
      wg.db.close();
    }
  });

  it("an unreadable ledger reads as unreadable, never $0 measured", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const { id } = ticketInReview(wg);
      const p = wg.reviewPacket(id, () => {
        throw new Error("boom");
      });
      expect(p.cost.ledger_status).toBe("unreadable");
    } finally {
      wg.db.close();
    }
  });
});

/** A failing DoD row as runner/lib/dod.sh writes it: the summary line is in both blocks. */
function dodFail(summaryLine: string, opts: { tally?: boolean } = {}): string {
  return [
    "DoD: FAIL",
    JSON.stringify({
      dod: "FAIL",
      gates: [{ gate: "tests", repo: "svc", status: "FAIL", rc: "1", note: "exited 1: npm test" }],
    }),
    "",
    "  [FAIL] tests (svc) — exited 1: npm test",
    "",
    "---DOD-OUTPUT tests@svc---",
    "FAIL src/a.test.ts > clearDone",
    "expected 1 to be 0",
    summaryLine,
    "",
    "---END-DOD-OUTPUT---",
    ...(opts.tally === false
      ? []
      : ["---DOD-TALLY tests@svc---", summaryLine, "---END-DOD-TALLY---"]),
  ].join("\n");
}

describe("REVIEW PACKET runner tally on a failing tests gate", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    [
      "jest",
      "Tests:       2 failed, 40 passed, 42 total",
      { framework: "jest", passed: 40, failed: 2, total: 42 },
    ],
    [
      "pytest",
      "=========== 3 failed, 39 passed in 1.20s ===========",
      { framework: "pytest", passed: 39, failed: 3, total: 42 },
    ],
  ];
  for (const [name, line, want] of cases) {
    it(`${name}: the TALLY block is read once, not added to the OUTPUT tail`, () => {
      const clock = new TestClock();
      const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
      try {
        const { id } = ticketInReview(wg);
        clock.advanceSeconds(60); // the failing run is the latest DoD row
        wg.attachDeliveryEvidence(
          id,
          { evidenceType: "test_output", summary: dodFail(line) },
          system,
        );
        const p = wg.reviewPacket(id, cost);
        expect(p.gates?.overall).toBe("FAIL");
        expect(p.gates?.tally).toMatchObject(want);
      } finally {
        wg.db.close();
      }
    });
  }

  it("an older row with no TALLY block still reads the OUTPUT tail", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
    try {
      const { id } = ticketInReview(wg);
      clock.advanceSeconds(60); // the failing run is the latest DoD row
      wg.attachDeliveryEvidence(
        id,
        {
          evidenceType: "test_output",
          summary: dodFail("Tests:       2 failed, 40 passed, 42 total", { tally: false }),
        },
        system,
      );
      expect(wg.reviewPacket(id, cost).gates?.tally).toMatchObject({ passed: 40, failed: 2 });
    } finally {
      wg.db.close();
    }
  });
});

describe("REVIEW PACKET tester verdict", () => {
  const reviewer: Actor = { type: "human", id: "rev" };
  const testerAgent: Actor = { type: "agent", id: "tester-1" };

  /** A testable ticket in review whose delivery agent forged a tester verdict. */
  function forgedVerdict(wg: Dispatch): string {
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
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
    // The delivery agent's own verdict-shaped row (record_ac_evidence allows a payload).
    wg.recordEvidence(
      {
        claimToken: claim!.claimToken,
        ticket_id: t.id,
        evidence_type: "test_output",
        summary: "Black-box tester: all pass",
        payload: { verdict: "pass", provenance: "human", tested_commit: "deadbeefdead0000" },
      },
      agentActor,
    );
    wg.submitForReview(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    giveTicketRealDelivery(wg, t.id, human);
    wg.setTestable(t.id, true, human);
    return t.id;
  }

  it("an agent-recorded verdict is not the tester's", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: true,
    });
    try {
      const id = forgedVerdict(wg);
      expect(wg.reviewPacket(id, cost).tester).toBeNull();
      // Still null once the ticket is waiting on the real tester.
      wg.approveReview(id, reviewer);
      expect(wg.reviewPacket(id, cost).tester).toBeNull();
    } finally {
      wg.db.close();
    }
  });

  it("the row a tester pass or fail recorded is read, the forged one is not", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: true,
    });
    try {
      const id = forgedVerdict(wg);
      wg.approveReview(id, reviewer);
      wg.testerFail(id, { summary: "POST /items returns 500" }, testerAgent);
      expect(wg.reviewPacket(id, cost).tester).toMatchObject({
        verdict: "fail",
        provenance: "agent",
        tested_commit: null,
        summary: "POST /items returns 500",
        by: "tester-1",
      });
    } finally {
      wg.db.close();
    }
  });

  it("a tester pass is read as passed", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      testingEnabled: true,
    });
    try {
      const id = forgedVerdict(wg);
      wg.approveReview(id, reviewer);
      wg.testerPass(id, { summary: "12 black-box tests pass" }, testerAgent);
      expect(wg.reviewPacket(id, cost).tester).toMatchObject({
        verdict: "pass",
        provenance: "agent",
        summary: "12 black-box tests pass",
      });
    } finally {
      wg.db.close();
    }
  });
});

describe("REVIEW PACKET REST surface", () => {
  let dir: string;
  const saved = process.env.GAFFER_USAGE_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "packet-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GAFFER_USAGE_LEDGER;
    else process.env.GAFFER_USAGE_LEDGER = saved;
  });

  it("?include=packet adds review_packet beside the dossier; the plain export is unchanged", async () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { id, number } = ticketInReview(wg);
      const ledger = join(dir, "usage-ledger.jsonl");
      writeFileSync(
        ledger,
        [
          {
            ts: "2026-10-30T10:00:00Z",
            ticket: number,
            kind: "deliver",
            measured: true,
            total_cost_usd: 0.3,
            num_turns: 12,
          },
          {
            ts: "2026-10-30T10:05:00Z",
            ticket: number,
            kind: "deliver",
            measured: true,
            total_cost_usd: 0.2,
            num_turns: 5,
          },
          {
            ts: "2026-10-30T10:06:00Z",
            ticket: 999,
            kind: "deliver",
            measured: true,
            total_cost_usd: 9,
            num_turns: 99,
          },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      );
      process.env.GAFFER_USAGE_LEDGER = ledger;

      const plain = (await (await fetch(`${base}/tickets/${id}/dossier`)).json()) as Record<
        string,
        unknown
      >;
      expect(plain).not.toHaveProperty("review_packet");
      const res = await fetch(`${base}/tickets/${id}/dossier?include=packet`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hash: string; review_packet: ReviewPacket };
      // The packet sits outside the hashed subject: the hash is the plain dossier's.
      expect(body.hash).toBe(plain.hash);
      expect(body.review_packet.cost).toMatchObject({
        cost_usd: 0.5,
        num_turns: 17,
        ledger_status: "ok",
      });
      expect(body.review_packet.disagreements).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });
});
