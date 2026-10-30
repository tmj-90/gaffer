// heartbeat-lease-grows: a heartbeat extends a claim by its ORIGINAL lease length,
// measured from the last beat — not from created_at, which made every beat add the
// time elapsed since the claim, so a crashed delivery held its ticket for hours.
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

function claimed(clock: TestClock, ttlSeconds: number): { wg: Dispatch; token: string } {
  const wg = Dispatch.open(":memory:", clock);
  const t = wg.createTicket({ title: "t", description: "d", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket(
    { agentId: agent.id, ttlSeconds },
    { type: "agent", id: agent.id },
  );
  return { wg, token: claim!.claimToken };
}

describe("heartbeat keeps the configured lease length", () => {
  it("six beats 300 s apart on a 600 s claim each extend to exactly now + 600 s", () => {
    const clock = new TestClock();
    const { wg, token } = claimed(clock, 600);
    for (let beat = 0; beat < 6; beat++) {
      clock.advanceSeconds(300);
      const { expiresAt } = wg.heartbeat(token);
      expect((new Date(expiresAt).getTime() - clock.nowMs()) / 1000).toBe(600);
    }
    wg.db.close();
  });

  it("with no heartbeat the claim expires once its 600 s lease passes", () => {
    const clock = new TestClock();
    const { wg } = claimed(clock, 600);
    clock.advanceSeconds(599);
    expect(wg.expireStaleClaims(system).expired).toBe(0);
    clock.advanceSeconds(2);
    expect(wg.expireStaleClaims(system).expired).toBe(1);
    wg.db.close();
  });

  it("after beats stop, the claim expires one lease after the last beat", () => {
    const clock = new TestClock();
    const { wg, token } = claimed(clock, 600);
    for (let beat = 0; beat < 5; beat++) {
      clock.advanceSeconds(300);
      wg.heartbeat(token);
    }
    clock.advanceSeconds(601);
    expect(wg.expireStaleClaims(system).expired).toBe(1);
    wg.db.close();
  });
});
