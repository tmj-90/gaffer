// System delivery evidence can carry structured detail (payload_json): the runner's
// per-attempt agent-run record (attempt, model, CLI version) rides on it so the
// ticket page's attempt history can show which model and CLI did each attempt.
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DELIVERY_EVIDENCE_PAYLOAD_MAX } from "../src/services/ticketService.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

function ticket(): { wg: Dispatch; id: string } {
  const wg = Dispatch.open(":memory:", new TestClock());
  const t = wg.createTicket({ title: "t", description: "d" }, human);
  return { wg, id: t.id };
}

describe("system delivery evidence payload", () => {
  it("stores a JSON object payload and returns it on the ticket view", () => {
    const { wg, id } = ticket();
    const run = { kind: "agent_run", attempt: 2, model: "stub-model-a", claude_version: "9.9.9" };
    wg.attachDeliveryEvidence(
      id,
      { evidenceType: "log", summary: "Agent run", payloadJson: JSON.stringify(run) },
      system,
    );
    const ev = wg.view(id).evidence.find((e) => e.evidence_type === "log");
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.payload_json!)).toEqual(run);
  });

  it("leaves payload_json null when none is given (unchanged behaviour)", () => {
    const { wg, id } = ticket();
    wg.attachDeliveryEvidence(id, { evidenceType: "log", summary: "plain" }, system);
    expect(wg.view(id).evidence[0]!.payload_json).toBeNull();
  });

  it.each([["[1,2]"], ['"text"'], ["not json"], ["null"]])(
    "refuses a non-object payload %s",
    (p) => {
      const { wg, id } = ticket();
      expect(() =>
        wg.attachDeliveryEvidence(
          id,
          { evidenceType: "log", summary: "x", payloadJson: p },
          system,
        ),
      ).toThrow(DispatchError);
      expect(wg.view(id).evidence).toHaveLength(0);
    },
  );

  it("refuses an oversized payload", () => {
    const { wg, id } = ticket();
    const big = JSON.stringify({ pad: "x".repeat(DELIVERY_EVIDENCE_PAYLOAD_MAX) });
    expect(() =>
      wg.attachDeliveryEvidence(
        id,
        { evidenceType: "log", summary: "x", payloadJson: big },
        system,
      ),
    ).toThrow(/over 4096/);
  });
});
