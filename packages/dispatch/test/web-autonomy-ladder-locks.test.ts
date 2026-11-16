// @vitest-environment jsdom
//
// THE AUTONOMY LADDER under the dashboard's permission locks (external review 20): the
// ladder panel loads after the page's permission pass, so its controls are created after
// the lock pass has run. The reviewer: the lift controls stayed enabled for read-only and
// non-admin viewers (the client then refused before any POST), and "Sign this row",
// created after its own read, had the same problem. Each control is locked when it is
// created, with the helper, title and class the rest of the page uses: a read-only viewer
// (is-read-only, the read-only title), a non-admin principal (the admin title), a scoped
// principal (is-scope-locked, the scope title). The operator's controls stay live.

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  humanActor as human,
  landedChange,
  repoNamed,
  ticketOn,
} from "./helpers/autonomyLadder.js";

const WEB = path.resolve(process.cwd(), "src/api/web");
const LADDER_JS = path.join(WEB, "js/views/autonomy-ladder.js");
const ACCESS_JS = path.join(WEB, "js/access.js");

const READ_ONLY_TITLE = "Read-only access: this token can look, not change anything.";

/** A ladder with a stepped-down row (api low merge) and an unsigned row (api medium approve). */
function staged(): { ladder: any; review: any } {
  const wg = Dispatch.open(":memory:");
  try {
    const api = repoNamed(wg, "api");
    wg.setAutonomyPolicy(
      { repoId: api, riskLevel: "low", gate: "merge", mode: "auto", confirm: true },
      human,
    );
    const change = landedChange(wg, "api", "low");
    wg.fileRegression(ticketOn(wg, "api", "low", "Export crashes").id, change.id, human, "x");
    wg.db
      .prepare(
        "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, created_at, updated_at) VALUES ('forged', ?, 'medium', 'approve', 'auto', 'tom', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
      )
      .run(api);
    return {
      ladder: JSON.parse(JSON.stringify(wg.autonomyLadder(null, "api"))),
      review: JSON.parse(JSON.stringify(wg.reviewUnsignedAutonomyPolicies())),
    };
  } finally {
    wg.db.close();
  }
}

let sent: string[] = [];
function stubFetch(ladder: unknown, review: unknown): void {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      sent.push(`${method} ${url}`);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (method === "POST") return json({ ok: true });
      if (url.includes("/api/autonomy/signatures")) return json(review);
      if (url.includes("/api/autonomy/ladder")) return json(ladder);
      return json({});
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

type Viewer = "read-only" | "non-admin principal" | "scoped principal" | "operator";
const WHOAMI: Record<Viewer, unknown> = {
  "read-only": { capability: "read", actor: { type: "human", id: "ro" } },
  "non-admin principal": {
    capability: "full",
    actor: { type: "human", id: "lee" },
    principal: { id: "p1", name: "lee" },
  },
  "scoped principal": {
    capability: "full",
    actor: { type: "admin", id: "ops" },
    principal: { id: "p2", name: "scoped" },
    scope: { repos: [{ id: "r-other", name: "other" }] },
  },
  operator: { capability: "full", actor: { type: "human", id: "tom" } },
};

/** The ladder panel as the dashboard mounts it: loaded after the permission pass. */
async function mount(viewer: Viewer) {
  const { ladder, review } = staged();
  stubFetch(ladder, review);
  const access = await import(ACCESS_JS);
  access.learnWhoami(WHOAMI[viewer]);
  const mod = await import(LADDER_JS);
  // A scoped token's client refuses the ladder's own read (the server's scope gate), so
  // the panel shows no ladder for it; the cells are drawn from the read model directly.
  const panel =
    viewer === "scoped principal"
      ? (mod.renderLadder(ladder) as HTMLElement)
      : (mod.autonomyLadderPanel() as HTMLElement);
  document.getElementById("app")!.appendChild(panel);
  for (let i = 0; i < 4; i += 1) await tick();
  const row = (risk: string) =>
    panel.querySelectorAll(`.al-repo[data-repo="api"] tr[data-risk="${risk}"] .al-cell`);
  const unsigned = row("medium")[0] as HTMLElement;
  const stepped = row("low")[1] as HTMLElement;
  expect(unsigned.getAttribute("data-rung")).toBe("unsigned");
  expect(stepped.getAttribute("data-rung")).toBe("stepped");
  return { access, unsigned, stepped };
}

function lockOf(node: Element | null) {
  const n = node as HTMLButtonElement | HTMLInputElement;
  return {
    disabled: n.disabled,
    aria: n.getAttribute("aria-disabled"),
    cls: n.classList.contains("is-read-only")
      ? "is-read-only"
      : n.classList.contains("is-scope-locked")
        ? "is-scope-locked"
        : null,
    title: n.title || null,
  };
}

describe("web: the autonomy ladder's controls are locked when they are created", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="toast" class="toast" role="alert" hidden></div><header id="appbar" class="appbar"></header><main id="app"></main>`;
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a read-only viewer: the lift and Sign this row are switched off with the read-only title", async () => {
    const { stepped, unsigned } = await mount("read-only");
    const want = { disabled: true, aria: "true", cls: "is-read-only", title: READ_ONLY_TITLE };
    expect(lockOf(stepped.querySelector(".al-lift button"))).toEqual(want);
    expect(lockOf(stepped.querySelector(".al-lift input"))).toEqual(want);
    // Reviewing is a read: it stays open; the sign control it creates is locked.
    const review = unsigned.querySelector(".al-sign button") as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    review.click();
    for (let i = 0; i < 4; i += 1) await tick();
    const sign = unsigned.querySelector(".al-sign button") as HTMLButtonElement;
    expect(sign.textContent).toContain("Sign this row");
    expect(lockOf(sign)).toEqual(want);
    sign.click();
    await tick();
    expect(sent.filter((s) => s.startsWith("POST"))).toEqual([]);
  });

  it("a non-admin principal: the lift and Sign this row carry the admin title", async () => {
    const { access, stepped, unsigned } = await mount("non-admin principal");
    const want = {
      disabled: true,
      aria: "true",
      cls: "is-scope-locked",
      title: access.ADMIN_TITLE,
    };
    expect(lockOf(stepped.querySelector(".al-lift button"))).toEqual(want);
    expect(lockOf(stepped.querySelector(".al-lift input"))).toEqual(want);
    (unsigned.querySelector(".al-sign button") as HTMLButtonElement).click();
    for (let i = 0; i < 4; i += 1) await tick();
    const sign = unsigned.querySelector(".al-sign button") as HTMLButtonElement;
    expect(sign.textContent).toContain("Sign this row");
    expect(lockOf(sign)).toEqual(want);
  });

  it("a scoped principal: the lift and the review are switched off with the scope title", async () => {
    const { access, stepped, unsigned } = await mount("scoped principal");
    const want = {
      disabled: true,
      aria: "true",
      cls: "is-scope-locked",
      title: access.scopeTitle(),
    };
    expect(lockOf(stepped.querySelector(".al-lift button"))).toEqual(want);
    expect(lockOf(stepped.querySelector(".al-lift input"))).toEqual(want);
    // The review's read is refused for a scoped token too (the server's scope gate).
    expect(lockOf(unsigned.querySelector(".al-sign button"))).toEqual(want);
  });

  it("the operator: every control is live and the lift and the signature are sent", async () => {
    const { stepped, unsigned } = await mount("operator");
    const free = { disabled: false, aria: null, cls: null, title: null };
    expect(lockOf(stepped.querySelector(".al-lift button"))).toEqual(free);
    expect(lockOf(stepped.querySelector(".al-lift input"))).toEqual(free);
    (stepped.querySelector(".al-lift input") as HTMLInputElement).value = "upstream regression";
    (stepped.querySelector(".al-lift button") as HTMLButtonElement).click();
    for (let i = 0; i < 4; i += 1) await tick();
    (unsigned.querySelector(".al-sign button") as HTMLButtonElement).click();
    for (let i = 0; i < 4; i += 1) await tick();
    const sign = unsigned.querySelector(".al-sign button") as HTMLButtonElement;
    expect(lockOf(sign)).toEqual(free);
    sign.click();
    for (let i = 0; i < 4; i += 1) await tick();
    const posts = sent
      .filter((s) => s.startsWith("POST"))
      .map((s) => s.replace(/^POST \S*?\/api/, "/api"));
    expect(posts).toEqual(["/api/autonomy/lift", "/api/autonomy/signatures/resign"]);
  });
});
