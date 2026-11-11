/**
 * FEATURE LANDING (external review 17, finding 3): the membership rule and the decision
 * `wg epic feature-status` answers (services/featureLanding.ts). The runner's merge ships a
 * memory-ledger feature only when this says `complete`; the end-to-end proof with the real
 * CLIs is runner/test/feature-ship-gate.test.mjs.
 */
import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { featureIdOf, featureLanding, featureLandings } from "../src/services/featureLanding.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  const wg = Dispatch.open(":memory:", new TestClock());
  wg.registerRepository({ name: "app", default_branch: "main" }, human);
  return wg;
}

/** An epic of `n` tickets, each carrying the feature's marker (as the idle loop files it). */
function featureEpic(wg: Dispatch, featureId: string, n = 2, extra: Record<string, unknown> = {}) {
  return wg.createEpic(
    {
      epic: { name: `Epic of ${featureId}`, description: "planned", ...extra },
      tickets: Array.from({ length: n }, (_, i) => ({
        title: `Part ${i + 1}`,
        description: `Part ${i + 1}.\n\nFeature-Id: ${featureId}`,
        acceptanceCriteria: ["works"],
        repo: "app",
      })),
    },
    human,
  );
}

function setStatus(wg: Dispatch, status: string, ...numbers: number[]): void {
  for (const n of numbers)
    wg.db.prepare("UPDATE tickets SET status = ? WHERE number = ?").run(status, n);
}

describe("featureIdOf", () => {
  it("reads the marker on its own line, the first one, exactly", () => {
    expect(featureIdOf("Do it.\n\nFeature-Id: f_1\n")).toBe("f_1");
    expect(featureIdOf("Feature-Id: a\nFeature-Id: b")).toBe("a");
    expect(featureIdOf("see Feature-Id: x inline")).toBeNull();
    expect(featureIdOf(null)).toBeNull();
  });
});

describe("featureLanding membership and decision", () => {
  it("counts every marked ticket and the epic's own acceptance ticket", () => {
    const wg = fresh();
    const res = featureEpic(wg, "f1");
    const [t1, t2, acc] = res.ticketNumbers as [number, number, number];
    expect(res.acceptanceTicketNumber).toBe(acc);
    const r = featureLanding(wg.db, { featureId: "f1" });
    expect(r.tickets.map((t) => t.number)).toEqual([t1, t2, acc]);
    expect(r.tickets.find((t) => t.number === acc)).toMatchObject({
      acceptance: true,
      via: ["epic"],
    });
    expect(r.tickets.find((t) => t.number === t1)?.via).toEqual(["epic", "marker"]);
    expect(r.epics).toHaveLength(1);
    expect(r.epics[0]!.acceptance_ticket).toBe(acc);
    expect(r.complete).toBe(false);
  });

  it("is complete only when every counted ticket is done, the acceptance ticket included", () => {
    const wg = fresh();
    const [t1, t2, acc] = featureEpic(wg, "f2").ticketNumbers as [number, number, number];
    setStatus(wg, "done", t1);
    expect(featureLanding(wg.db, { featureId: "f2" }).complete).toBe(false);
    setStatus(wg, "done", t2);
    const before = featureLanding(wg.db, { featureId: "f2" });
    expect(before.complete).toBe(false);
    expect(before.pending).toEqual([acc]);
    setStatus(wg, "done", acc);
    const after = featureLanding(wg.db, { featureId: "f2" });
    expect(after.complete).toBe(true);
    expect(after.landed).toEqual([t1, t2, acc]);
  });

  it("does not wait for a cancelled ticket, and never completes on cancelled work alone", () => {
    const wg = fresh();
    const [t1, t2, acc] = featureEpic(wg, "f3").ticketNumbers as [number, number, number];
    setStatus(wg, "cancelled", t1, t2, acc);
    const none = featureLanding(wg.db, { featureId: "f3" });
    expect(none.complete).toBe(false);
    expect(none.reason).toMatch(/cancelled: nothing landed/);
    setStatus(wg, "done", t1, acc);
    const r = featureLanding(wg.db, { featureId: "f3" });
    expect(r.complete).toBe(true);
    expect(r.cancelled).toEqual([t2]);
  });

  it("resolves the feature from a ticket: its marker, else its epic (the acceptance ticket)", () => {
    const wg = fresh();
    const [t1, , acc] = featureEpic(wg, "f4").ticketNumbers as [number, number, number];
    expect(featureLanding(wg.db, { ticketRef: String(t1) })).toMatchObject({
      feature_id: "f4",
      resolved_from: "marker",
    });
    expect(featureLanding(wg.db, { ticketRef: String(acc) })).toMatchObject({
      feature_id: "f4",
      resolved_from: "epic",
    });
    const lone = wg.createTicket({ title: "Lone", description: "no feature" }, human);
    const r = featureLanding(wg.db, { ticketRef: String(lone.number) });
    expect(r.feature_id).toBeNull();
    expect(r.complete).toBe(false);
  });

  it("a marked ticket outside the epic still has to land (union, the cross-check)", () => {
    const wg = fresh();
    const [t1, t2, acc] = featureEpic(wg, "f5").ticketNumbers as [number, number, number];
    const stray = wg.createTicket({ title: "Stray", description: "x\n\nFeature-Id: f5" }, human);
    setStatus(wg, "done", t1, t2, acc);
    const r = featureLanding(wg.db, { featureId: "f5" });
    expect(r.complete).toBe(false);
    expect(r.pending).toEqual([stray.number]);
    expect(r.tickets.find((t) => t.number === stray.number)?.via).toEqual(["marker"]);
  });

  it("a ticket the caller names (a prepared delta claiming the feature) is counted", () => {
    const wg = fresh();
    const [t1, t2, acc] = featureEpic(wg, "f6").ticketNumbers as [number, number, number];
    const docs = wg.createTicket({ title: "Docs", description: "docs" }, human);
    setStatus(wg, "done", t1, t2, acc);
    const r = featureLanding(wg.db, { featureId: "f6", ticketRef: String(docs.number) });
    expect(r.complete).toBe(false);
    expect(r.tickets.find((t) => t.number === docs.number)?.via).toEqual(["ticket"]);
    setStatus(wg, "done", docs.number!);
    expect(
      featureLanding(wg.db, { featureId: "f6", ticketRef: String(docs.number) }).complete,
    ).toBe(true);
  });

  it("marked tickets that no epic holds never complete a feature (a stray marker is not a feature)", () => {
    // The loop files every feature as an epic. A ticket that only CARRIES the marker
    // (an ingested issue body quoting it, in a code block or not) used to complete a
    // feature that had no epic yet (claimed, still being planned) or never had one (a
    // backlog feature): its landing shipped a feature nobody built.
    const wg = fresh();
    const stray = wg.createTicket(
      { title: "Issue #12", description: "Steps:\n```\nFeature-Id: f8\n```\n" },
      human,
    );
    setStatus(wg, "done", stray.number!);
    const r = featureLanding(wg.db, { featureId: "f8" });
    expect(r.tickets.map((t) => t.number)).toEqual([stray.number]);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/no epic/);
    const byTicket = featureLanding(wg.db, { ticketRef: String(stray.number) });
    expect(byTicket.feature_id).toBe("f8");
    expect(byTicket.complete).toBe(false);
    // Once the feature's epic exists, the stray ticket is one more ticket to land.
    const [t1, acc] = featureEpic(wg, "f8", 1).ticketNumbers as [number, number];
    setStatus(wg, "done", t1, acc);
    expect(featureLanding(wg.db, { featureId: "f8" }).complete).toBe(true);
    // An epic filed without an acceptance ticket still anchors the feature.
    const [solo] = featureEpic(wg, "f9", 1, { acceptance: false }).ticketNumbers as [number];
    setStatus(wg, "done", solo);
    expect(featureLanding(wg.db, { featureId: "f9" }).complete).toBe(true);
    // A prepared delta's claim (the named ticket, no marker anywhere) needs no epic.
    const docs = wg.createTicket({ title: "Docs", description: "docs" }, human);
    setStatus(wg, "done", docs.number!);
    expect(
      featureLanding(wg.db, { featureId: "f10", ticketRef: String(docs.number) }).complete,
    ).toBe(true);
  });

  it("says which features a ticket's epics name when they name more than one", () => {
    const wg = fresh();
    const res = wg.createEpic(
      {
        epic: { name: "Two features", description: "x" },
        tickets: [
          {
            title: "A",
            description: "a\n\nFeature-Id: fa",
            acceptanceCriteria: ["w"],
            repo: "app",
          },
          {
            title: "B",
            description: "b\n\nFeature-Id: fb",
            acceptanceCriteria: ["w"],
            repo: "app",
          },
        ],
      },
      human,
    );
    const acc = res.acceptanceTicketNumber!;
    const r = featureLanding(wg.db, { ticketRef: String(acc) });
    expect(r.feature_id).toBeNull();
    expect(r.ambiguous_features).toEqual(["fa", "fb"]);
    expect(featureLanding(wg.db, { featureId: "fa" }).ambiguous_features).toEqual([]);
  });

  it("answers for many features in one call, each as it would alone", () => {
    const wg = fresh();
    const [a1, aacc] = featureEpic(wg, "ma", 1).ticketNumbers as [number, number];
    featureEpic(wg, "mb", 2);
    setStatus(wg, "done", a1, aacc);
    const many = featureLandings(wg.db, ["ma", "mb", "none"]);
    expect(many.map((r) => r.feature_id)).toEqual(["ma", "mb", "none"]);
    for (const r of many) {
      expect(r).toEqual(featureLanding(wg.db, { featureId: r.feature_id }));
    }
    expect(many.map((r) => r.complete)).toEqual([true, false, false]);
  });

  it("a feature with no tickets is never complete", () => {
    const wg = fresh();
    const r = featureLanding(wg.db, { featureId: "nothing" });
    expect(r.complete).toBe(false);
    expect(r.tickets).toEqual([]);
  });
});
