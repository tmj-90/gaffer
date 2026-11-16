// @vitest-environment jsdom
//
// THE AUTONOMY LADDER view (backlog 58): rendered from a REAL read model (Dispatch's
// autonomyLadder on a staged record), every repo x risk x gate cell has a rung word and a
// mark, critical says the ceiling, a stepped-down cell shows its reason and what lifts it
// (and the lift POSTs a person's override), the evidence reads "k of n" with a whisker,
// the Overview line names a recent step-down, and Settings mounts the panel.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  decisions,
  humanActor as human,
  landedChange,
  repoNamed,
  ticketOn,
} from "./helpers/autonomyLadder.js";

const WEB = path.resolve(process.cwd(), "src/api/web");
const LADDER_JS = pathToFileURL(path.join(WEB, "js/views/autonomy-ladder.js")).href;
const APP_JS = pathToFileURL(path.join(WEB, "app.js")).href;

/** A ladder with every state: api stepped down at low (cascade above), web climbing. */
function stagedLadder(): unknown {
  const wg = Dispatch.open(":memory:");
  try {
    const api = repoNamed(wg, "api");
    repoNamed(wg, "web");
    wg.setAutonomyPolicy(
      { repoId: api, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
      human,
    );
    wg.setAutonomyPolicy(
      { repoId: api, riskLevel: "medium", gate: "approve", mode: "auto", confirm: true },
      human,
    );
    decisions(wg, "web", "low", 7);
    const change = landedChange(wg, "api", "low");
    wg.fileRegression(ticketOn(wg, "api", "low", "Export crashes").id, change.id, human, "x");
    return JSON.parse(JSON.stringify(wg.autonomyLadder()));
  } finally {
    wg.db.close();
  }
}

let posts: Array<{ url: string; body: any }> = [];
function stubFetch(ladder: unknown): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "POST") {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return json({ lifted: { event_id: "e1", how: "override" } });
      }
      if (url.includes("/api/autonomy/ladder")) return json(ladder);
      if (url.includes("/api/autonomy/policies")) return json({ policies: [] });
      if (url.includes("/api/autonomy/recommendations")) return json({ recommendations: [] });
      if (url.includes("/api/settings"))
        return json({
          settings: [
            {
              key: "DISPATCH_ALLOW_AGENT_APPROVE",
              value: "0",
              envLocked: false,
              type: "boolean",
              group: "autonomy",
              label: "Agents may approve reviews",
            },
          ],
        });
      if (url.includes("/api/idle-loops")) return json({});
      if (url.includes("/repositories")) return json({ repositories: [] });
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      return json({});
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const SHELL = `
  <div id="toast" class="toast" role="alert" hidden></div>
  <div class="shell">
    <header id="appbar" class="appbar" hidden></header>
    <main id="app" class="app"><p class="loading">Loading…</p></main>
    <nav id="bottomnav" class="bottomnav" hidden></nav>
  </div>`;

describe("web: the autonomy ladder", () => {
  let ladder: any;
  beforeEach(() => {
    ladder = stagedLadder();
    document.body.innerHTML = SHELL;
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("every repo x risk x gate cell has a rung word and a mark; critical says the ceiling", async () => {
    stubFetch(ladder);
    const mod = await import(`${LADDER_JS}?t=${Date.now()}`);
    const root = mod.renderLadder(ladder) as HTMLElement;
    document.getElementById("app")!.appendChild(root);
    const repos = [...root.querySelectorAll(".al-repo")];
    expect(repos.map((r) => r.getAttribute("data-repo"))).toEqual(["api", "web"]);
    for (const repo of repos) {
      const rows = [...repo.querySelectorAll("tbody tr")];
      expect(rows.map((r) => r.getAttribute("data-risk"))).toEqual([
        "low",
        "medium",
        "high",
        "critical",
      ]);
      for (const row of rows) {
        const cells = [...row.querySelectorAll(".al-cell")];
        expect(cells.length).toBe(2);
        for (const c of cells) {
          expect(c.querySelector(".al-rung-word")!.textContent!.trim().length).toBeGreaterThan(0);
          expect(c.querySelector(".al-rung svg")).not.toBeNull();
          // On a phone the cell names its own gate.
          expect(["Approve", "Merge"]).toContain(c.querySelector(".al-gate-label")!.textContent);
        }
        if (row.getAttribute("data-risk") === "critical") {
          for (const c of cells) {
            expect(c.getAttribute("data-rung")).toBe("ceiling");
            expect(c.textContent).toContain(
              "Not allowed: a person always decides critical changes.",
            );
          }
        }
      }
    }
  });

  it("a stepped-down cell says why and what lifts it; the lift POSTs a person's override", async () => {
    stubFetch(ladder);
    const mod = await import(`${LADDER_JS}?t=${Date.now()}`);
    const root = mod.renderLadder(ladder) as HTMLElement;
    document.getElementById("app")!.appendChild(root);
    const api = root.querySelector('.al-repo[data-repo="api"]')!;
    const lowMerge = api.querySelectorAll('tr[data-risk="low"] .al-cell')[1]!;
    expect(lowMerge.getAttribute("data-rung")).toBe("stepped");
    expect(lowMerge.querySelector(".al-rung-word")!.textContent).toBe("Stepped down");
    expect(lowMerge.textContent).toContain("after a regression");
    expect(lowMerge.textContent).toMatch(/was linked by human:tom as a regression of #\d+/);
    expect(lowMerge.textContent).toMatch(/re-enables it once the evidence/);
    // The cascade reads as its own reason.
    const highMerge = api.querySelectorAll('tr[data-risk="high"] .al-cell')[1]!;
    expect(highMerge.textContent).toContain("after a lower risk stepped down");
    // ... and lifts only after low: no form there, a sentence that says so.
    expect(highMerge.querySelector("button")).toBeNull();
    expect(highMerge.textContent).toContain("Give low risk back first");
    // Medium approve is automatic (its row, not stepped down).
    const medApprove = api.querySelectorAll('tr[data-risk="medium"] .al-cell')[0]!;
    expect(medApprove.querySelector(".al-rung-word")!.textContent).toBe("Automatic");
    // An override without a reason is not sent.
    const btn = lowMerge.querySelector("button")!;
    expect(btn.textContent).toContain("Override");
    btn.click();
    await tick();
    expect(posts).toEqual([]);
    (lowMerge.querySelector("input") as HTMLInputElement).value = "the regression was upstream";
    btn.click();
    await tick();
    await tick();
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toContain("/api/autonomy/lift");
    expect(posts[0]!.body).toMatchObject({
      risk_level: "low",
      gate: "merge",
      how: "override",
      reason: "the regression was upstream",
    });
  });

  it("a climbing cell shows k of n with its whisker and the distance in plain numbers", async () => {
    stubFetch(ladder);
    const mod = await import(`${LADDER_JS}?t=${Date.now()}`);
    const root = mod.renderLadder(ladder) as HTMLElement;
    const web = root.querySelector('.al-repo[data-repo="web"]')!;
    const lowApprove = web.querySelectorAll('tr[data-risk="low"] .al-cell')[0]!;
    expect(lowApprove.getAttribute("data-rung")).toBe("person");
    expect(lowApprove.querySelector(".mr-fig")!.textContent).toContain("7 of 7");
    expect(lowApprove.querySelector(".mr-whisker")).not.toBeNull();
    expect(lowApprove.querySelector(".al-distance")!.textContent).toContain("7 of 10 decisions");
    expect(lowApprove.querySelector(".al-distance")!.textContent).toContain("3 more");
  });

  it("the Overview line names the repository and why, once per repository", async () => {
    stubFetch(ladder);
    const mod = await import(`${LADDER_JS}?t=${Date.now()}`);
    const lines = mod.stepDownLines(ladder) as HTMLElement[];
    expect(lines.length).toBe(1);
    expect(lines[0]!.textContent).toMatch(/^Autonomy stepped down on api: #\d+ was linked/);
    const box = mod.autonomyStepDownLine() as HTMLElement;
    expect(box.hidden).toBe(true);
    await tick();
    await tick();
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain("Autonomy stepped down on api");
    // The line asks for the narrow read (the recent step-downs alone), not the ladder.
    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(asked.some((u) => u.includes("/api/autonomy/ladder?recent=1"))).toBe(true);
    // No step-down on record: the line stays hidden.
    stubFetch({ ...ladder, recent_step_downs: [] });
    const quiet = mod.autonomyStepDownLine() as HTMLElement;
    await tick();
    await tick();
    expect(quiet.hidden).toBe(true);
  });

  it("Settings mounts the ladder panel and fills it from the read model", async () => {
    stubFetch(ladder);
    document.body.innerHTML = SHELL;
    location.hash = "#/settings";
    await import(`${APP_JS}?t=${Date.now()}`);
    for (let i = 0; i < 6; i += 1) await tick();
    const panel = document.querySelector(".autonomy-ladder");
    expect(panel).not.toBeNull();
    expect(panel!.querySelectorAll(".al-cell").length).toBe(16);
  });
});
