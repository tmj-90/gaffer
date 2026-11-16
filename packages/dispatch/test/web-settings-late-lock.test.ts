// @vitest-environment jsdom
//
// Controls the Settings page mounts AFTER its first render take the same permission lock
// as the rest of the page. The page locked its main column once (roLockAll at render), so
// a panel that fills itself after its own read (the autonomy ladder's lift form and
// signing buttons) or is rebuilt later (the Access list after a credential is made) drew
// live-looking controls for a viewer the server refuses: a read-only token, a principal
// that is not an admin, and a scoped principal. The server already refuses them; the
// defect was a control that looks usable and is not.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import { resetDerivedSettings, settingsReport } from "../src/api/settings.js";
import {
  decisions,
  humanActor as human,
  landedChange,
  repoNamed,
  ticketOn,
} from "./helpers/autonomyLadder.js";

const WEB = path.resolve(process.cwd(), "src/api/web");
const APP_JS = pathToFileURL(path.join(WEB, "app.js")).href;
const AUTONOMY_JS = pathToFileURL(path.join(WEB, "js/views/autonomy.js")).href;
const CLUB_JS = pathToFileURL(path.join(WEB, "js/club.js")).href;

/** A ladder with a stepped-down row (a lift form) and unsigned rows (sign buttons). */
function stagedLadder(): unknown {
  const wg = Dispatch.open(":memory:");
  try {
    const api = repoNamed(wg, "api");
    repoNamed(wg, "web");
    wg.setAutonomyPolicy(
      { repoId: api, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
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

const VIEWERS: Record<string, unknown> = {
  "a read-only token": { capability: "read", actor: { type: "system", id: "op" }, principal: null },
  "a principal that is not an admin": {
    capability: "full",
    actor: { type: "human", id: "bob" },
    principal: { id: "p1", name: "bob" },
    scope: null,
  },
  "a scoped principal": {
    capability: "full",
    actor: { type: "admin", id: "ann" },
    principal: { id: "p2", name: "ann" },
    scope: { repos: [{ id: "r1", name: "api" }], tickets: null },
  },
};

let dir: string;
let report: unknown;
let ladder: unknown;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-late-lock-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ GAFFER_MODE: "graduated" }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir };
  resetDerivedSettings(env);
  report = {
    ...settingsReport(env, join(dir, "settings.json")),
    isolation: { provider: "docker", available: true, optedOut: false },
  };
  ladder = stagedLadder();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stubFetch(whoami: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/whoami")) return json(whoami);
      if (url.includes("/api/autonomy/ladder")) return json(ladder);
      if (url.includes("/api/autonomy/policies")) return json({ policies: [] });
      if (url.includes("/api/autonomy/recommendations")) return json({ recommendations: [] });
      if (url.includes("/api/settings")) return json(report);
      if (url.includes("/api/principals")) return json({ principals: [] });
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

describe("web: Settings controls mounted after the first render are locked too", () => {
  beforeEach(() => {
    document.body.innerHTML = SHELL;
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  for (const [who, whoami] of Object.entries(VIEWERS)) {
    it(`the autonomy ladder's controls, for ${who}`, async () => {
      stubFetch(whoami);
      location.hash = "#/settings";
      await import(`${APP_JS}?t=${Date.now()}${Math.random()}`);
      for (let i = 0; i < 8; i += 1) await tick();
      const panel = document.querySelector(".autonomy-ladder");
      if (who === "a scoped principal") {
        // The page does not even read the factory-wide settings for a scoped token
        // (api.js refuses the read as the server would): no settings controls to lock.
        if (panel === null) return;
      }
      expect(panel!.querySelectorAll(".al-cell").length).toBeGreaterThan(0);
      const controls = [...panel!.querySelectorAll("button, input, select, textarea")];
      expect(controls.length).toBeGreaterThan(0);
      for (const c of controls) {
        const label = c.textContent || c.getAttribute("placeholder") || c.outerHTML.slice(0, 60);
        expect((c as HTMLButtonElement).disabled, label).toBe(true);
        expect(c.getAttribute("aria-disabled"), label).toBe("true");
        expect(c.getAttribute("title"), label).toMatch(/access/i);
      }
    });
  }

  it("the Access list rebuilt after a credential is made keeps the lock", async () => {
    // A session whose capability is learned as read-only after the panel was drawn for a
    // full token (the panel decides what to draw from its own whoami): the rebuilt list
    // must take the page's lock, as the first render does.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (method === "POST")
          return json({ token: "t0k", principal: { id: "p9", name: "carol" } });
        if (url.includes("/api/principals"))
          return json({
            principals: [
              {
                id: "p9",
                name: "carol",
                capability: "full",
                actor_type: "human",
                actor_id: "carol",
                created_at: "2026-11-16",
              },
            ],
          });
        return json({});
      }),
    );
    // The same module instances the panel imports (vi.resetModules gave fresh ones).
    const { squad } = await import(CLUB_JS);
    const { accessPanel } = await import(AUTONOMY_JS);
    squad.capability = "full";
    const card = accessPanel({ capability: "full", actor: { type: "system", id: "op" } }, []);
    document.body.appendChild(card);
    (card.querySelector("input[name=principal-name]") as HTMLInputElement).value = "carol";
    (card.querySelector("form.access-form") as HTMLFormElement).requestSubmit();
    // The capability turns out read-only while the request is in flight.
    squad.capability = "read";
    for (let i = 0; i < 6; i += 1) await tick();
    const revoke = [...card.querySelectorAll(".access-list button")];
    expect(revoke.length).toBeGreaterThan(0);
    for (const b of revoke) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
