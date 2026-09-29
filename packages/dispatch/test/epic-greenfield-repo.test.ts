/**
 * GREENFIELD EPICS (server-side): a plan whose tickets name a repo that does not exist
 * yet — the repo the plan's bootstrap ticket will create — used to fail `createEpic`
 * with NOT_FOUND on the CLI/API path, while the dashboard quietly stripped the repo and
 * carried its name onto `source` before posting. One plan, two behaviours. The server
 * now applies the same rule for every caller: an unregistered repo name rides onto
 * `source` (unless the plan set one) and the repo link is deferred to bootstrap; a
 * REGISTERED repo is linked exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

function plan(repo: string, extra: Record<string, unknown> = {}) {
  return {
    epic: { name: "Habit Ledger", description: "greenfield" },
    tickets: [
      {
        title: "Bootstrap the repo",
        description: "scaffold",
        acceptanceCriteria: ["repo exists"],
        bootstrap: true,
        repo,
        dependsOn: [],
        ...extra,
      },
      {
        title: "Core store",
        description: "json",
        acceptanceCriteria: ["atomic writes"],
        repo,
        dependsOn: [0],
      },
    ],
  };
}

describe("createEpic: greenfield plans that name a not-yet-existing repo", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:");
  });
  afterEach(() => {
    d.db.close();
  });

  it("creates the epic, carries the repo NAME onto source, and defers every repo link", () => {
    const res = d.createEpic(plan("habit-ledger"), human);
    // 2 plan tickets + the acceptance ticket; every one defers its link to bootstrap.
    expect(res.ticketNumbers).toHaveLength(3);
    expect(res.deferredRepoLinks).toBe(3);
    for (const n of res.ticketNumbers) {
      const view = d.view(String(n));
      expect(view.ticket.source).toBe("habit-ledger");
      expect(view.repositories ?? []).toHaveLength(0);
    }
    expect(d.view(String(res.ticketNumbers[0])).ticket.bootstrap).toBe(1);
  });

  it("keeps an explicit source and still defers the link", () => {
    const res = d.createEpic(plan("habit-ledger", { source: "ledger-app" }), human);
    expect(d.view(String(res.ticketNumbers[0])).ticket.source).toBe("ledger-app");
    expect(d.view(String(res.ticketNumbers[1])).ticket.source).toBe("habit-ledger");
    expect(res.deferredRepoLinks).toBe(3);
  });

  it("a bootstrap ticket declares HIGH risk by default; an explicit risk and non-bootstrap tickets are untouched", () => {
    const res = d.createEpic(plan("habit-ledger"), human);
    expect(d.view(String(res.ticketNumbers[0])).ticket.risk_level).toBe("high");
    expect(d.view(String(res.ticketNumbers[1])).ticket.risk_level).toBe("medium");
    const res2 = d.createEpic(plan("other-app", { risk_level: "low" }), human);
    expect(d.view(String(res2.ticketNumbers[0])).ticket.risk_level).toBe("low");
  });

  it("links a REGISTERED repo exactly as before (nothing deferred)", () => {
    d.registerRepository(
      { name: "habit-ledger", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const res = d.createEpic(plan("habit-ledger"), human);
    expect(res.deferredRepoLinks).toBe(0);
    for (const n of res.ticketNumbers) {
      const view = d.view(String(n));
      expect((view.repositories ?? []).map((r) => r.name)).toEqual(["habit-ledger"]);
      expect(view.ticket.source).toBeNull();
    }
  });
});
