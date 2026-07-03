import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  isSpecCoverageGateEnabled,
  SPEC_COVERAGE_GATE_ENV,
} from "../src/policy/specCoverageGate.js";
import { parseSpecClauses, type Actor, type SpecClause } from "../src/domain/types.js";
import { SpecCoverageService } from "../src/services/specCoverageService.js";
import type { SpecLoreReader } from "../src/services/specLoreReader.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

/**
 * Build a spec whose clauses have KNOWN ids by supplying them, then thread ACs to
 * those ids directly. This keeps the read-model test at the repository/service
 * boundary — no epic/decompose machinery — so the SQL aggregation is what's under
 * test. Returns the wired Dispatch plus the clause-id map for assertions.
 */
function seedCoverageFixture(): {
  wg: Dispatch;
  specId: string;
  ids: Record<"green" | "partial" | "open" | "gap", string>;
} {
  const wg = Dispatch.open(":memory:", new TestClock());
  const clauses: SpecClause[] = [
    { clause_id: "C-green", kind: "requirement", text: "User can pay with a saved card" },
    { clause_id: "C-partial", kind: "requirement", text: "Receipt is emailed after payment" },
    { clause_id: "C-open", kind: "requirement", text: "Refunds are processed within 24h" },
    {
      clause_id: "C-gap",
      kind: "non-goal",
      text: "No crypto payments",
      rationale: "Out of scope for v1",
    },
  ];
  const spec = wg.createSpec({ title: "Checkout", brief: "Rework checkout", clauses }, human);
  // Freeze so the fixture matches the real (frozen-spec) coverage path.
  wg.freezeSpec(spec.id, human);

  // Clause ids are NAMESPACED under the spec on create (`<specId>:C-green`), so ACs
  // must thread the stored (namespaced) ids — exactly what the real spec-driven flow
  // does when it reads the frozen spec back. Map base → namespaced id for the fixture.
  const stored = parseSpecClauses(wg.getSpec(spec.id).clauses_json);
  const nid = (base: string): string =>
    stored.find((c) => c.clause_id === `${spec.id}:${base}`)!.clause_id;
  const ids = {
    green: nid("C-green"),
    partial: nid("C-partial"),
    open: nid("C-open"),
    gap: nid("C-gap"),
  };

  const now = new TestClock().now();
  const addAc = (
    ticketId: string,
    text: string,
    clauseId: string | undefined,
    satisfied: boolean,
  ): string => {
    const { ac } = wg.addAcceptanceCriterion(
      { ticket_id: ticketId, text, ...(clauseId ? { spec_clause_id: clauseId } : {}) },
      human,
    );
    if (satisfied) wg.acs.setStatus(ac.id, "satisfied", "tester", now);
    return ac.id;
  };

  // C-green: one ticket, AC satisfied → covered + satisfied.
  const t1 = wg.createTicket({ title: "Saved-card payment" }, human);
  addAc(t1.id, "pays with saved card", ids.green, true);

  // C-partial: two ACs across two tickets — one satisfied, one pending → covered + satisfied.
  const t2 = wg.createTicket({ title: "Receipt email" }, human);
  addAc(t2.id, "receipt is queued", ids.partial, true);
  const t3 = wg.createTicket({ title: "Receipt template" }, human);
  addAc(t3.id, "receipt template exists", ids.partial, false);

  // C-open: covered by a ticket but the AC is unsatisfied → covered, NOT satisfied.
  const t4 = wg.createTicket({ title: "Refund worker" }, human);
  const openAc = addAc(t4.id, "refund within 24h", ids.open, false);

  // C-gap: NO covering AC → orphan (the negative control / gap report).

  // ORPHAN-TICKET control: an AC whose spec_clause_id points at a clause that does
  // NOT exist on the spec must be ignored — it can't inflate any clause's coverage.
  // (Bare, un-namespaced id: belongs to no spec, so it's neither covering nor dangling.)
  const t5 = wg.createTicket({ title: "Dangling" }, human);
  addAc(t5.id, "references a ghost clause", "C-does-not-exist", true);
  // ...and an AC with NO clause link at all is likewise ignored.
  addAc(t5.id, "unlinked AC", undefined, true);

  // Bounce trail: two rework attempts on the C-green ticket (join via its AC's
  // ticket) + one on the C-open ticket. The gap/partial clauses have none.
  wg.reworkAttempts.insert({
    id: "rw-1",
    ticket_id: t1.id,
    attempt: 1,
    max_attempts: 3,
    gate: "tests",
    distilled_failure: "assert failed",
    ac_id: null,
    created_at: "2026-06-20T10:00:00.000Z",
  });
  wg.reworkAttempts.insert({
    id: "rw-2",
    ticket_id: t1.id,
    attempt: 2,
    max_attempts: 3,
    gate: "definition-of-done",
    distilled_failure: "dod failed",
    ac_id: null,
    created_at: "2026-06-20T11:00:00.000Z",
  });
  wg.reworkAttempts.insert({
    id: "rw-3",
    ticket_id: t4.id,
    attempt: 1,
    max_attempts: 3,
    gate: "lint",
    distilled_failure: "lint failed",
    ac_id: openAc,
    created_at: "2026-06-20T12:00:00.000Z",
  });

  return { wg, specId: spec.id, ids };
}

describe("Spec-Driven Development (Phase 3): coverage read model", () => {
  it("marks a clause with a satisfied AC as covered + satisfied (GREEN)", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    const green = cov.clauses.find((c) => c.clause_id === ids.green)!;
    expect(green.covered).toBe(true);
    expect(green.satisfied).toBe(true);
    expect(green.orphan).toBe(false);
    expect(green.covering_acs).toHaveLength(1);
    expect(green.covering_acs[0]!.satisfied).toBe(true);
  });

  it("marks a partially-covered clause satisfied when ANY covering AC is satisfied", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const partial = wg.specCoverage(specId).clauses.find((c) => c.clause_id === ids.partial)!;
    expect(partial.covering_acs).toHaveLength(2);
    expect(partial.covered).toBe(true);
    expect(partial.satisfied).toBe(true);
    // Exactly one of the two ACs is satisfied.
    expect(partial.covering_acs.filter((a) => a.satisfied)).toHaveLength(1);
  });

  it("marks a covered-but-unsatisfied clause OPEN (covered, not satisfied)", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const open = wg.specCoverage(specId).clauses.find((c) => c.clause_id === ids.open)!;
    expect(open.covered).toBe(true);
    expect(open.satisfied).toBe(false);
    expect(open.orphan).toBe(false);
  });

  it("NEGATIVE CONTROL: a clause with no covering AC is an orphan in the gap report, never counted covered", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    const gap = cov.clauses.find((c) => c.clause_id === ids.gap)!;
    expect(gap.covered).toBe(false);
    expect(gap.satisfied).toBe(false);
    expect(gap.orphan).toBe(true);
    expect(gap.covering_acs).toHaveLength(0);
    // Surfaces in the rollup gap report...
    expect(cov.rollup.orphans).toContain(ids.gap);
    // ...and is NOT counted toward covered/satisfied.
    expect(cov.rollup.total).toBe(4);
    expect(cov.rollup.covered).toBe(3);
    expect(cov.rollup.satisfied).toBe(2);
  });

  it("ORPHAN-TICKET control: an AC referencing a non-existent clause never appears or inflates coverage", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    // Only the four real clauses are traced — no ghost clause leaks in.
    expect(cov.clauses.map((c) => c.clause_id).sort()).toEqual(
      [ids.gap, ids.green, ids.open, ids.partial].sort(),
    );
    // Total covering ACs across the trace excludes the dangling + unlinked ACs.
    const totalAcs = cov.clauses.reduce((n, c) => n + c.covering_acs.length, 0);
    expect(totalAcs).toBe(4); // green(1) + partial(2) + open(1)
  });

  it("SQL AGGREGATION: bounce_count joins the rework trail to the clause via its ACs' tickets", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    const by = (id: string) => cov.clauses.find((c) => c.clause_id === id)!;
    // C-green's ticket has two rework attempts → bounced 2×.
    expect(by(ids.green).bounce_count).toBe(2);
    // C-open's ticket has one → bounced 1×.
    expect(by(ids.open).bounce_count).toBe(1);
    // Clauses whose tickets never bounced (and the gap clause) are zero.
    expect(by(ids.partial).bounce_count).toBe(0);
    expect(by(ids.gap).bounce_count).toBe(0);
  });

  it("preserves clause order, kind and rationale from the frozen spec", () => {
    const { wg, specId, ids } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    expect(cov.clauses.map((c) => c.clause_id)).toEqual([
      ids.green,
      ids.partial,
      ids.open,
      ids.gap,
    ]);
    const gap = cov.clauses.find((c) => c.clause_id === ids.gap)!;
    expect(gap.kind).toBe("non-goal");
    expect(gap.rationale).toBe("Out of scope for v1");
  });

  it("has no dangling ACs in the healthy fixture (bare/unlinked ACs are not in the namespace)", () => {
    const { wg, specId } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    expect(cov.dangling_acs).toHaveLength(0);
    expect(cov.rollup.dangling).toBe(0);
  });

  it("throws NOT_FOUND for an unknown spec id", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    expect(() => wg.specCoverage("nope")).toThrow(DispatchError);
    try {
      wg.specCoverage("nope");
    } catch (e) {
      expect((e as DispatchError).code).toBe("NOT_FOUND");
    }
  });

  it("reports lore_status = unknown for every clause when Memory is unwired", () => {
    const { wg, specId } = seedCoverageFixture();
    const cov = wg.specCoverage(specId);
    for (const c of cov.clauses) expect(c.lore_status).toBe("unknown");
  });
});

// --- CROSS-SPEC ISOLATION: the clause-id namespacing correctness fix ----------
describe("Spec-Driven Development (Phase 3): cross-spec coverage isolation", () => {
  // Both specs author the SAME positional clause ids (c1, c2). Before namespacing,
  // `spec_clause_id IN (…)` matched by bare id, so spec A's ticket ACs inflated
  // spec B's coverage and bounce counts (and vice-versa). Namespacing each id under
  // its spec makes them globally unique, so each spec's coverage sees ONLY its own
  // tickets. This is the exact metric the feature computes — the negative control is
  // that spec A's numbers are unaffected by spec B's work.
  it("two specs with colliding positional ids do NOT cross-contaminate coverage or bounces", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const now = new TestClock().now();

    const mkSpec = (title: string, text: string): { id: string; c1: string; c2: string } => {
      const s = wg.createSpec(
        {
          title,
          clauses: [
            { clause_id: "c1", kind: "requirement", text },
            { clause_id: "c2", kind: "requirement", text: `${text} — part two` },
          ],
        },
        human,
      );
      wg.freezeSpec(s.id, human);
      const stored = parseSpecClauses(wg.getSpec(s.id).clauses_json);
      return { id: s.id, c1: stored[0]!.clause_id, c2: stored[1]!.clause_id };
    };

    const A = mkSpec("Spec A", "A requirement");
    const B = mkSpec("Spec B", "B requirement");

    // Both authored bare `c1`, but the stored (namespaced) ids are distinct.
    expect(A.c1).not.toBe(B.c1);
    expect(A.c1.endsWith(":c1")).toBe(true);
    expect(B.c1.endsWith(":c1")).toBe(true);

    // Spec A: one ticket covering A.c1 (SATISFIED) with TWO rework bounces.
    const ta = wg.createTicket({ title: "A work" }, human);
    const { ac: aAc } = wg.addAcceptanceCriterion(
      { ticket_id: ta.id, text: "does A", spec_clause_id: A.c1 },
      human,
    );
    wg.acs.setStatus(aAc.id, "satisfied", "tester", now);
    wg.reworkAttempts.insert({
      id: "a-rw-1",
      ticket_id: ta.id,
      attempt: 1,
      max_attempts: 3,
      gate: "tests",
      distilled_failure: "x",
      ac_id: null,
      created_at: "2026-06-20T10:00:00.000Z",
    });
    wg.reworkAttempts.insert({
      id: "a-rw-2",
      ticket_id: ta.id,
      attempt: 2,
      max_attempts: 3,
      gate: "lint",
      distilled_failure: "y",
      ac_id: null,
      created_at: "2026-06-20T11:00:00.000Z",
    });

    // Spec B: one ticket covering B.c1 (PENDING), zero bounces.
    const tb = wg.createTicket({ title: "B work" }, human);
    wg.addAcceptanceCriterion({ ticket_id: tb.id, text: "does B", spec_clause_id: B.c1 }, human);

    // Spec A sees ONLY its own AC + its own bounces.
    const covA = wg.specCoverage(A.id);
    const a1 = covA.clauses.find((c) => c.clause_id === A.c1)!;
    expect(a1.covering_acs).toHaveLength(1);
    expect(a1.covered).toBe(true);
    expect(a1.satisfied).toBe(true);
    expect(a1.bounce_count).toBe(2);
    expect(covA.clauses.find((c) => c.clause_id === A.c2)!.orphan).toBe(true);

    // NEGATIVE CONTROL: spec B is untouched by spec A's satisfied AC + 2 bounces.
    const covB = wg.specCoverage(B.id);
    const b1 = covB.clauses.find((c) => c.clause_id === B.c1)!;
    expect(b1.covering_acs).toHaveLength(1); // ONLY B's AC — not A's
    expect(b1.covered).toBe(true);
    expect(b1.satisfied).toBe(false); // A's satisfied AC did NOT leak in
    expect(b1.bounce_count).toBe(0); // A's 2 bounces did NOT leak in
  });
});

// --- DANGLING ACs: broken provenance links (ticket-side gap report) -----------
describe("Spec-Driven Development (Phase 3): dangling-AC reporting", () => {
  it("reports an AC that references a now-removed clause in the spec's namespace", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const spec = wg.createSpec(
      { title: "Spec", clauses: [{ clause_id: "c1", kind: "requirement", text: "live clause" }] },
      human,
    );
    wg.freezeSpec(spec.id, human);
    const liveId = parseSpecClauses(wg.getSpec(spec.id).clauses_json)[0]!.clause_id;

    // A healthy AC covering the live clause.
    const t1 = wg.createTicket({ title: "Good" }, human);
    wg.addAcceptanceCriterion(
      { ticket_id: t1.id, text: "covers c1", spec_clause_id: liveId },
      human,
    );

    // A DANGLING AC: it claims a clause in THIS spec's namespace that no longer
    // exists (e.g. a clause removed while drafting). It must surface in the report.
    const deadId = `${spec.id}:c-removed`;
    const t2 = wg.createTicket({ title: "Stale" }, human);
    const { ac: dead } = wg.addAcceptanceCriterion(
      { ticket_id: t2.id, text: "covers a removed clause", spec_clause_id: deadId },
      human,
    );

    const cov = wg.specCoverage(spec.id);
    // The live clause is covered and NOT an orphan.
    expect(cov.clauses.find((c) => c.clause_id === liveId)!.covered).toBe(true);
    // The dangling AC is reported once, with its dead reference + ticket.
    expect(cov.dangling_acs).toHaveLength(1);
    expect(cov.rollup.dangling).toBe(1);
    const d = cov.dangling_acs[0]!;
    expect(d.ac_id).toBe(dead.id);
    expect(d.spec_clause_id).toBe(deadId);
    expect(d.ticket_id).toBe(t2.id);
    expect(d.ac_text).toBe("covers a removed clause");
  });

  it("NEGATIVE CONTROL: a healthy AC and an unrelated (foreign-namespace) AC are not dangling", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const spec = wg.createSpec(
      { title: "Spec", clauses: [{ clause_id: "c1", kind: "requirement", text: "live" }] },
      human,
    );
    wg.freezeSpec(spec.id, human);
    const liveId = parseSpecClauses(wg.getSpec(spec.id).clauses_json)[0]!.clause_id;

    const t = wg.createTicket({ title: "T" }, human);
    wg.addAcceptanceCriterion(
      { ticket_id: t.id, text: "covers c1", spec_clause_id: liveId },
      human,
    );
    // A bare id belonging to no spec namespace, and a different spec's namespaced id.
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "bare", spec_clause_id: "c1" }, human);
    wg.addAcceptanceCriterion(
      { ticket_id: t.id, text: "other spec", spec_clause_id: "some-other-spec:c1" },
      human,
    );

    const cov = wg.specCoverage(spec.id);
    expect(cov.dangling_acs).toHaveLength(0);
    expect(cov.rollup.dangling).toBe(0);
  });
});

// --- Lore-status attachment (best-effort) + DoD gate seam ------------------

describe("Spec-Driven Development (Phase 3): lore status + DoD gate seam", () => {
  it("attaches an injected reader's per-clause lore status onto the trace", () => {
    const { wg, specId } = seedCoverageFixture();
    const spec = wg.specsRepo.findById(specId)!;
    const clauseIds = parseSpecClauses(spec.clauses_json).map((c) => c.clause_id);
    // A reader that ratifies the first clause, drafts the second, leaves the rest absent.
    const reader: SpecLoreReader = {
      statusFor: (_spec, clauses) =>
        new Map(
          clauses.map((c, i) => [c.clause_id, i === 0 ? "active" : i === 1 ? "draft" : "absent"]),
        ),
    };
    const svc = new SpecCoverageService({
      specs: wg.specsRepo,
      coverage: wg.specCoverageRepo,
      loreReader: reader,
    });
    const cov = svc.specCoverage(specId);
    expect(cov.clauses.find((c) => c.clause_id === clauseIds[0])!.lore_status).toBe("active");
    expect(cov.clauses.find((c) => c.clause_id === clauseIds[1])!.lore_status).toBe("draft");
    expect(cov.clauses.find((c) => c.clause_id === clauseIds[2])!.lore_status).toBe("absent");
  });

  it("degrades to unknown (never throws) when the injected reader throws", () => {
    const { wg, specId } = seedCoverageFixture();
    const throwing: SpecLoreReader = {
      statusFor: () => {
        throw new Error("memory exploded");
      },
    };
    const svc = new SpecCoverageService({
      specs: wg.specsRepo,
      coverage: wg.specCoverageRepo,
      loreReader: throwing,
    });
    const cov = svc.specCoverage(specId);
    for (const c of cov.clauses) expect(c.lore_status).toBe("unknown");
  });

  it("DoD gate flag is OFF by default and reflected as gate_enabled=false", () => {
    const { wg, specId } = seedCoverageFixture();
    expect(wg.specCoverage(specId).gate_enabled).toBe(false);
    // The policy reader itself is off unless the env flag is truthy.
    expect(isSpecCoverageGateEnabled({})).toBe(false);
    expect(isSpecCoverageGateEnabled({ [SPEC_COVERAGE_GATE_ENV]: "1" })).toBe(true);
    expect(isSpecCoverageGateEnabled({ [SPEC_COVERAGE_GATE_ENV]: "nope" })).toBe(false);
  });

  it("surfaces gate_enabled=true when the (non-enforcing) gate reader is armed", () => {
    const { wg, specId } = seedCoverageFixture();
    const svc = new SpecCoverageService({
      specs: wg.specsRepo,
      coverage: wg.specCoverageRepo,
      gateEnabled: () => true,
    });
    // Advisory only: the flag flips the bit but nothing is gated.
    expect(svc.specCoverage(specId).gate_enabled).toBe(true);
  });
});
