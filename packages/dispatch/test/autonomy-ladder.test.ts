/**
 * THE AUTONOMY LADDER read model (GET /api/autonomy/ladder, `wg autonomy ladder`).
 *
 *  - every repo x risk x gate has a cell with a rung: person / suggested / automatic;
 *  - the evidence: k of n human decisions, the rate, its Wilson interval, the threshold
 *    and the minimum sample; the distance to the next rung in plain numbers;
 *  - critical is never automatic (the ceiling), even with a stored `auto` row or a
 *    mode's env floor;
 *  - the cross-repo prior counts at low and medium only (high needs this repo's evidence);
 *  - a scoped principal sees only the repos in its repo scope.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { renderLadder } from "../src/cli/commands/autonomy.js";
import { Dispatch } from "../src/core.js";
import {
  distanceText,
  moreNeeded,
  wilson,
  type AutonomyLadder,
  type LadderCell,
} from "../src/services/autonomyLadderService.js";
import { CEILING_MESSAGE } from "../src/services/autonomyPolicyService.js";
import { newId } from "../src/util/id.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";
import { decisions, humanActor, repoNamed } from "./helpers/autonomyLadder.js";

const FLAGS = ["AUTO_MERGE", "MERGE_ON_AGENT_REVIEW", "DISPATCH_ALLOW_AGENT_APPROVE"];

function cell(
  l: AutonomyLadder,
  repo: string,
  risk: string,
  gate: "approve" | "merge",
): LadderCell {
  const r = l.repos.find((x) => x.repo_name === repo);
  if (!r) throw new Error(`no repo ${repo}`);
  const row = r.rows.find((x) => x.risk_level === risk);
  if (!row) throw new Error(`no risk ${risk}`);
  return row.gates[gate];
}

describe("ladder arithmetic", () => {
  it("moreNeeded: the smallest run of agreeing decisions that clears the bar", () => {
    expect(moreNeeded(7, 7, 10, 0.9)).toBe(3);
    expect(moreNeeded(0, 0, 10, 0.9)).toBe(10);
    expect(moreNeeded(10, 10, 10, 0.9)).toBe(0);
    expect(moreNeeded(9, 10, 10, 0.9)).toBe(0); // exactly 90%
    expect(moreNeeded(8, 10, 10, 0.9)).toBe(10); // 18 of 20
    expect(moreNeeded(9, 12, 10, 0.9)).toBe(18); // 27 of 30
    expect(moreNeeded(0, 3, 10, 0.9)).toBe(27); // 27 of 30
  });

  it("wilson: exact edges, null without a sample", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(10, 10)?.hi).toBe(1);
    expect(wilson(0, 10)?.lo).toBe(0);
    const w = wilson(7, 10)!;
    expect(w.lo).toBeGreaterThan(0.39);
    expect(w.lo).toBeLessThan(0.4);
    expect(w.hi).toBeGreaterThan(0.89);
    expect(w.hi).toBeLessThan(0.9);
  });

  it("distanceText reads the brief's own example", () => {
    const e = {
      measure: "agreement" as const,
      k: 7,
      n: 7,
      rate: 1,
      wilson: wilson(7, 7),
      threshold: 0.9,
      min_samples: 10,
      since: null,
      clears: false,
    };
    expect(distanceText(e, moreNeeded(7, 7, 10, 0.9))).toBe(
      "7 of 10 decisions, 100% agreement: 3 more",
    );
    expect(distanceText({ ...e, k: 0, n: 0, rate: null, wilson: null }, 10)).toBe(
      "0 of 10 decisions: 10 more",
    );
    expect(distanceText({ ...e, k: 9, n: 12, rate: 0.75 }, 18)).toBe(
      "12 decisions, 75% agreement: 18 more",
    );
  });
});

describe("GET /api/autonomy/ladder read model", () => {
  let wg: Dispatch;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const f of FLAGS) {
      saved[f] = process.env[f];
      delete process.env[f];
    }
    wg = Dispatch.open(":memory:");
  });
  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
    wg.db.close();
  });

  it("every repo x risk x gate has a cell; a fresh repo is all `person`, critical is the ceiling", () => {
    repoNamed(wg, "api");
    repoNamed(wg, "web");
    const l = wg.autonomyLadder();
    expect(l.repos.map((r) => r.repo_name).sort()).toEqual(["api", "web"]);
    for (const r of l.repos) {
      expect(r.rows.map((x) => x.risk_level)).toEqual(["low", "medium", "high", "critical"]);
      for (const row of r.rows) {
        for (const gate of ["approve", "merge"] as const) {
          const c = row.gates[gate];
          expect(c.rung).toBe("person");
          expect(c.evidence.min_samples).toBe(10);
          expect(c.evidence.threshold).toBe(0.9);
          expect(c.step_down).toBeNull();
          if (row.risk_level === "critical") {
            expect(c.ceiling).toBe(true);
            expect(c.distance.text).toBe(CEILING_MESSAGE);
            expect(c.distance.more).toBeNull();
          } else {
            expect(c.ceiling).toBe(false);
            expect(c.distance.more).toBe(10);
          }
        }
      }
    }
    expect(cell(l, "api", "low", "approve").distance.text).toBe("0 of 10 decisions: 10 more");
    expect(l.rules.ceiling_risk).toBe("critical");
    expect(l.recent_step_downs).toEqual([]);
  });

  it("climbing: 7 agreeing decisions are 3 short, with the rate and its Wilson interval", () => {
    decisions(wg, "api", "low", 7);
    const c = cell(wg.autonomyLadder(), "api", "low", "approve");
    expect(c.rung).toBe("person");
    expect(c.evidence).toMatchObject({ k: 7, n: 7, rate: 1, measure: "agreement" });
    expect(c.evidence.wilson?.hi).toBe(1);
    expect(c.evidence.wilson?.lo).toBeGreaterThan(0.6);
    expect(c.distance).toEqual({ more: 3, text: "7 of 10 decisions, 100% agreement: 3 more" });
    const m = cell(wg.autonomyLadder(), "api", "low", "merge");
    expect(m.evidence).toMatchObject({ k: 7, n: 7, measure: "approved_unchanged" });
    expect(m.distance.text).toBe(
      "7 of 10 approvals with a known edit record, 100% approved unchanged: 3 more",
    );
  });

  it("a rejection counts against agreement: 9 approvals of 12 decisions need 18 more", () => {
    decisions(wg, "api", "medium", 9);
    decisions(wg, "api", "medium", 3, "reject");
    const c = cell(wg.autonomyLadder(), "api", "medium", "approve");
    expect(c.evidence).toMatchObject({ k: 9, n: 12, rate: 0.75 });
    expect(c.distance).toEqual({ more: 18, text: "12 decisions, 75% agreement: 18 more" });
  });

  it("agents' decisions are not evidence", () => {
    decisions(wg, "api", "low", 12, "approve", { actor: { type: "agent", id: "bot" } });
    expect(cell(wg.autonomyLadder(), "api", "low", "approve").evidence.n).toBe(0);
  });

  it("suggested: 10 agreeing, unchanged decisions clear both bars", () => {
    decisions(wg, "api", "medium", 10);
    const l = wg.autonomyLadder();
    for (const gate of ["approve", "merge"] as const) {
      const c = cell(l, "api", "medium", gate);
      expect(c.rung).toBe("suggested");
      expect(c.evidence.clears).toBe(true);
      expect(c.distance).toEqual({ more: 0, text: "Clears the bar: a person can turn it on." });
    }
  });

  it("automatic: an `auto` row, or the mode's env floor (never at critical)", () => {
    const api = repoNamed(wg, "api");
    wg.setAutonomyPolicy(
      { repoId: api, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
      humanActor,
    );
    let l = wg.autonomyLadder();
    expect(cell(l, "api", "low", "merge")).toMatchObject({
      rung: "automatic",
      source: "policy",
      policy_mode: "auto",
    });
    expect(cell(l, "api", "low", "approve").rung).toBe("person");
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    l = wg.autonomyLadder();
    expect(cell(l, "api", "high", "approve")).toMatchObject({ rung: "automatic", source: "mode" });
    expect(cell(l, "api", "critical", "approve")).toMatchObject({ rung: "person", ceiling: true });
  });

  it("critical: a stored `auto` row is shown as not allowed", () => {
    const api = repoNamed(wg, "api");
    // A row written before the ceiling existed (straight into the store).
    wg.autonomyPolicy.upsert({
      id: newId(),
      repoId: api,
      riskLevel: "critical",
      gate: "merge",
      mode: "auto",
      enabledBy: "tom",
      enabledAt: wg.clock.now(),
      evidenceJson: null,
      now: wg.clock.now(),
    });
    const c = cell(wg.autonomyLadder(), "api", "critical", "merge");
    expect(c).toMatchObject({ rung: "person", ceiling: true, policy_mode: "auto" });
    expect(c.distance.text).toBe(CEILING_MESSAGE);
  });

  it("the cross-repo prior counts at low and medium, never at high", () => {
    for (const repo of ["api", "web"]) {
      decisions(wg, repo, "low", 5);
      decisions(wg, repo, "high", 5);
    }
    const l = wg.autonomyLadder();
    const low = cell(l, "api", "low", "approve");
    expect(low.evidence.clears).toBe(false);
    expect(low.prior).toEqual({ used: true, k: 10, n: 10 });
    expect(low.rung).toBe("suggested");
    const high = cell(l, "api", "high", "approve");
    expect(high.prior.used).toBe(false);
    expect(high.rung).toBe("person");
    expect(high.distance.more).toBe(5);
  });

  it("scope: a scoped principal sees only the repos in its repo scope, and no cross-repo counts", () => {
    repoNamed(wg, "api");
    repoNamed(wg, "web");
    for (const repo of ["api", "web"]) decisions(wg, repo, "low", 5);
    const { principal } = wg.createPrincipal(
      { name: "api-only", actorType: "human", actorId: "ann", repos: ["api"] },
      humanActor,
    );
    const l = wg.autonomyLadder(principal);
    expect(l.repos.map((r) => r.repo_name)).toEqual(["api"]);
    expect(cell(l, "api", "low", "approve").prior).toEqual({ used: true, k: null, n: null });
    expect(() => wg.autonomyLadder(principal, "web")).toThrow(/not found/i);
    // A ticket grant reaches no repo's autonomy.
    const t = wg.createTicket({ title: "x" }, humanActor);
    wg.linkRepository(t.id, "web", "primary", humanActor);
    const { principal: ticketOnly } = wg.createPrincipal(
      { name: "one-ticket", actorType: "human", actorId: "bo", tickets: [t.id] },
      humanActor,
    );
    expect(wg.autonomyLadder(ticketOnly).repos).toEqual([]);
  });

  it("renders as text: a word for every cell, the ceiling, the distance", () => {
    decisions(wg, "api", "low", 7);
    const text = renderLadder(wg.autonomyLadder());
    expect(text).toContain("api");
    expect(text).toMatch(/low\s+approve\s+a person decides\s+7 of 7\s+7 of 10 decisions/);
    expect(text).toMatch(/critical\s+merge\s+not allowed/);
  });
});

describe("REST and CLI surfaces", () => {
  const FULL = "shared-full-token-for-ladder-tests-0123456789abcdef";
  const savedToken = process.env.DISPATCH_API_TOKEN;
  afterEach(() => {
    setPrincipalResolver(null);
    if (savedToken === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = savedToken;
  });

  it("GET /api/autonomy/ladder: the operator sees every repo, a scoped principal its own", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const wg = Dispatch.open(":memory:");
    repoNamed(wg, "api");
    repoNamed(wg, "web");
    const { token } = wg.createPrincipal(
      { name: "api-only", actorType: "human", actorId: "ann", repos: ["api"] },
      humanActor,
    );
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const get = async (path: string, tok: string) => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tok}` } });
        return { status: res.status, body: (await res.json()) as AutonomyLadder };
      };
      const all = await get("/api/autonomy/ladder", FULL);
      expect(all.status).toBe(200);
      expect(all.body.repos.map((r) => r.repo_name).sort()).toEqual(["api", "web"]);
      const one = await get("/api/autonomy/ladder?repo=web", FULL);
      expect(one.body.repos.map((r) => r.repo_name)).toEqual(["web"]);
      const scoped = await get("/api/autonomy/ladder", token);
      expect(scoped.status).toBe(200);
      expect(scoped.body.repos.map((r) => r.repo_name)).toEqual(["api"]);
      expect((await get("/api/autonomy/ladder?repo=web", token)).status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });

  it.skipIf(!CLI_BUILT)("wg autonomy ladder [--repo] [--json]", () => {
    const dir = mkdtempSync(join(tmpdir(), "ladder-cli-"));
    try {
      const db = join(dir, "d.db");
      const wg = Dispatch.open(db);
      repoNamed(wg, "api");
      repoNamed(wg, "web");
      decisions(wg, "api", "low", 7);
      wg.db.close();
      const j = runBin(db, ["autonomy", "ladder", "--repo", "api", "--json"]);
      expect(j.status).toBe(0);
      const body = JSON.parse(j.stdout) as AutonomyLadder & { ok: boolean };
      expect(body.ok).toBe(true);
      expect(body.repos.map((r) => r.repo_name)).toEqual(["api"]);
      expect(cell(body, "api", "low", "approve").distance.more).toBe(3);
      const t = runBin(db, ["autonomy", "ladder"]);
      expect(t.status).toBe(0);
      expect(t.stdout).toContain("7 of 10 decisions, 100% agreement: 3 more");
      expect(t.stdout).toContain("web");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
