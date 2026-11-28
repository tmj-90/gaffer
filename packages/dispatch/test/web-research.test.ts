// @vitest-environment jsdom
//
// RESEARCH FIRST in the dashboard (backlog 69).
//   - Inert rendering (protection G): a result holding `<img src=...>`, a Markdown
//     `[x](javascript:...)` link, an http link, a javascript: URL and a look-alike host
//     renders as plain text: no element is made from research text, no image or embed
//     at all, and the only link is a safe https source, opened with
//     rel="noopener noreferrer", with its full host beside it.
//   - The checkbox on the Plan a build brief form: UNCHECKED by default, and unticked
//     the brief goes to the planner exactly as before (no /research call); ticked it
//     starts a research run (no planner call); a read token, a scoped token and a host
//     where research cannot start see it disabled with the reason as its title.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_DIR = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(APP_DIR, "app.js");
const RESEARCH_JS = path.join(APP_DIR, "js", "views", "research.js");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function mountShell(hash = "#/epics"): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}

const hostile = {
  id: "r1",
  idea: "<b>idea</b>",
  status: "ready",
  summary: "[click me](javascript:alert(1)) <script>alert(2)</script>",
  findings: [
    {
      id: "f1",
      claim: '<img src="https://evil.example.org/x.png" onerror="alert(3)">',
      why: "<iframe src=https://evil.example.org></iframe>",
      opinion: false,
      sources: [
        { url: "https://docs.python.org/3/", host: "docs.python.org", fetched: true },
        { url: "http://plain.example.org/", host: "plain.example.org", fetched: false },
        { url: "javascript:alert(4)", host: "x", fetched: false },
        { url: "https://evil.example.org/", host: "docs.python.org", fetched: false },
        { url: "https://user:pw@docs.python.org/", host: "docs.python.org", fetched: false },
      ],
    },
  ],
  comparables: [
    {
      name: "<svg onload=alert(5)>",
      note: "n",
      source: { url: "https://www.strong.app/", host: "www.strong.app", fetched: false },
    },
  ],
  features: [
    {
      id: "ft1",
      title: "<img src=x>",
      description: "![pic](https://evil.example.org/p.png)",
      priority: "must",
      backed_by: ["f1"],
      unsupported: false,
      origin: "agent",
      kept: true,
    },
  ],
  open_questions: [{ id: "q1", text: "<a href='javascript:x'>q</a>", kept: true }],
  risks: [{ id: "k1", text: "<object data=x></object>" }],
  log: {
    fetches: [{ url: "https://docs.python.org/3/", host: "docs.python.org", ts: "t" }],
    searches: [],
  },
  dropped_urls: 0,
  spec_id: null,
};

describe("web: research results render as inert text", () => {
  beforeEach(() => mountShell());
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("makes no element out of research text and links only safe https sources", async () => {
    const mod = await import(`${pathToFileURL(RESEARCH_JS).href}?t=${Date.now()}`);
    const node = mod.renderResearchRun(hostile, {
      state: mod.researchEditState(hostile),
      locked: false,
      repaint: () => {},
      onSave: () => {},
      onDraft: () => {},
    });
    document.body.appendChild(node);
    expect(
      node.querySelectorAll(
        "img, iframe, script, object, embed, svg, video, audio, link, source, picture",
      ).length,
    ).toBe(0);
    const text = node.textContent ?? "";
    expect(text).toContain('<img src="https://evil.example.org/x.png" onerror="alert(3)">');
    expect(text).toContain("[click me](javascript:alert(1))");
    expect(text).toContain("<svg onload=alert(5)>");
    const links = Array.from((node as HTMLElement).querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://docs.python.org/3/",
      "https://www.strong.app/",
    ]);
    for (const a of links) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.parentElement?.textContent).toContain(
        `(${new URL(a.getAttribute("href")!).hostname})`,
      );
    }
    // The http link, the javascript: URL, the look-alike and the userinfo URL are text.
    const inert = Array.from((node as HTMLElement).querySelectorAll(".rs-inert")).map(
      (s) => s.textContent,
    );
    expect(inert).toEqual([
      "http://plain.example.org/",
      "javascript:alert(4)",
      "https://evil.example.org/",
      "https://user:pw@docs.python.org/",
    ]);
    expect(text).toContain("not fetched by the run");
    // The feature title is an input value, never markup.
    const title = node.querySelector(".rs-title-input") as HTMLInputElement;
    expect(title.value).toBe("<img src=x>");
    expect((node.querySelector(".rs-desc") as HTMLTextAreaElement).value).toBe(
      "![pic](https://evil.example.org/p.png)",
    );
  });

  it("safeResearchHref refuses every unsafe shape", async () => {
    const mod = await import(`${pathToFileURL(RESEARCH_JS).href}?t=${Date.now()}`);
    expect(mod.safeResearchHref({ url: "https://github.com/a", host: "github.com" })).toBe(
      "https://github.com/a",
    );
    for (const s of [
      { url: "http://github.com/a", host: "github.com" },
      { url: "javascript:alert(1)", host: "github.com" },
      { url: "data:text/html,x", host: "github.com" },
      { url: "https://github.com.evil.org/", host: "github.com" },
      { url: "https://github.com:8443/", host: "github.com" },
      { url: " https://github.com/", host: "github.com" },
      { url: "HTTPS://github.com/", host: "github.com" },
      { url: 42, host: "github.com" },
      null,
    ]) {
      expect(mod.safeResearchHref(s)).toBeNull();
    }
  });
});

// --- the checkbox on the Plan a build brief form -------------------------------------------
interface World {
  capability?: string;
  scope?: unknown;
  available?: boolean;
  reason?: string | null;
  /** How long POST /research takes to answer. */
  researchDelayMs?: number;
  /** The active plan session the panel restores (a reload), holding a research run. */
  activeSession?: Record<string, unknown>;
}
const calls: string[] = [];
function stubFetch(w: World): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      let body: unknown = {};
      if (url.includes("/api/whoami"))
        body = {
          capability: w.capability ?? "full",
          actor: { type: "human", id: "tom" },
          principal: null,
          scope: w.scope ?? null,
        };
      else if (url.includes("/research/availability"))
        body = { available: w.available ?? true, reason: w.reason ?? null };
      else if (url.includes("/plan-sessions/active")) body = { session: w.activeSession ?? null };
      else if (url.includes("/research?plan_session="))
        body = { research: w.activeSession ? [{ ...hostile, id: "r9", status: "ready" }] : [] };
      else if (url.endsWith("/plan-sessions") && method === "POST")
        body = { session: { id: "ps-1" } };
      else if (url.includes("/plan-build"))
        body = { phase: "clarify", questions: ["Which platform?"] };
      else if (url.endsWith("/research") && method === "POST") {
        if (w.researchDelayMs) await tick(w.researchDelayMs);
        body = { research: { ...hostile, id: "r9", status: "running" }, started: true };
      } else if (url.includes("/research/r9"))
        body = { research: { ...hostile, id: "r9", status: "running" } };
      else if (url.includes("/scope/nodes")) body = { nodes: [] };
      else if (url.includes("/repositories")) body = { repositories: [] };
      else if (url.includes("/tickets")) body = { tickets: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function openPanel(): Promise<HTMLElement> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}${Math.random()}`);
  await tick(20);
  const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Plan a build"),
  );
  expect(trigger).toBeTruthy();
  trigger!.click();
  await tick(30);
  return document.querySelector(".pb-panel") as HTMLElement;
}

async function sendBrief(panel: HTMLElement, text: string): Promise<void> {
  const input = panel.querySelector(".pb-input") as HTMLTextAreaElement;
  input.value = text;
  (panel.querySelector(".pb-composer") as HTMLFormElement).requestSubmit();
  await tick(30);
}

describe("web: the research checkbox on the Plan a build brief form", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("is unchecked by default, and unticked the brief goes to the planner only", async () => {
    stubFetch({});
    const panel = await openPanel();
    const box = panel.querySelector(".pb-research-box") as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(panel.querySelector(".pb-research-label")?.textContent).toContain(
      "Research this idea on the web first",
    );
    expect(panel.querySelector(".pb-research-hint")?.textContent).toMatch(
      /paid web research run.*search provider/,
    );
    await sendBrief(panel, "a gym workout tracker");
    expect(calls.some((c) => c.startsWith("POST /plan-build"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /research"))).toBe(false);
  });

  it("ticked, the brief starts a research run and not the planner", async () => {
    stubFetch({});
    const panel = await openPanel();
    const box = panel.querySelector(".pb-research-box") as HTMLInputElement;
    box.click();
    expect(box.checked).toBe(true);
    await sendBrief(panel, "a gym workout tracker");
    expect(calls.filter((c) => c.startsWith("POST /research"))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("POST /plan-build"))).toBe(false);
    expect(panel.querySelector(".rs-card")?.textContent).toContain("searching and reading pages");
    expect((panel.querySelector(".pb-composer") as HTMLElement).hidden).toBe(true);
  });

  it("ticked, a second message typed while the run is starting goes nowhere: one paid run", async () => {
    stubFetch({ researchDelayMs: 150 });
    const panel = await openPanel();
    (panel.querySelector(".pb-research-box") as HTMLInputElement).click();
    const input = panel.querySelector(".pb-input") as HTMLTextAreaElement;
    const form = panel.querySelector(".pb-composer") as HTMLFormElement;
    input.value = "a gym workout tracker";
    form.requestSubmit();
    await tick(10);
    input.value = "and make it offline";
    form.requestSubmit();
    form.requestSubmit();
    await tick(250);
    expect(calls.filter((c) => c.startsWith("POST /research"))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("POST /plan-build"))).toBe(false);
  });

  it("a reload finds the session's research run again and never starts a second one", async () => {
    stubFetch({
      activeSession: {
        id: "ps-1",
        brief: "a gym workout tracker",
        messages_json: JSON.stringify([{ role: "user", content: "a gym workout tracker" }]),
      },
    });
    const panel = await openPanel();
    await tick(50);
    expect(calls.some((c) => c.startsWith("GET /research?plan_session=ps-1"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /research"))).toBe(false);
    expect(calls.some((c) => c.startsWith("POST /plan-build"))).toBe(false);
    expect(panel.querySelector(".rs-card")).not.toBeNull();
  });

  // The Plan a build page (#/create) holds the panel inline, for every credential.
  async function openInline(w: World): Promise<HTMLInputElement> {
    mountShell("#/create");
    stubFetch(w);
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}${Math.random()}`);
    await tick(60);
    const box = document.querySelector(".pb-panel .pb-research-box") as HTMLInputElement;
    expect(box).not.toBeNull();
    return box;
  }

  it("is disabled with the reason as its title when the host cannot start research", async () => {
    const box = await openInline({
      available: false,
      reason: "Research is a paid run and needs a dollar cap first.",
    });
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("title")).toMatch(/dollar cap/);
    expect(box.checked).toBe(false);
  });

  it("is disabled for a read token", async () => {
    const box = await openInline({ capability: "read" });
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(box.getAttribute("title")).toMatch(/Read-only/);
  });

  it("is disabled with the reason when the host has no usable sandbox", async () => {
    const box = await openInline({
      available: false,
      reason: "Research runs only inside an OS sandbox, and this host has none right now.",
    });
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("title")).toMatch(/OS sandbox/);
  });

  it("does not keep the choice anywhere: not in local storage, and unticked on the next panel", async () => {
    stubFetch({});
    const panel = await openPanel();
    const box = panel.querySelector(".pb-research-box") as HTMLInputElement;
    box.click();
    expect(box.checked).toBe(true);
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/research/i);
    vi.resetModules();
    mountShell();
    const again = await openPanel();
    expect((again.querySelector(".pb-research-box") as HTMLInputElement).checked).toBe(false);
  });

  it("is disabled for a scoped token, with the scope as the reason", async () => {
    const box = await openInline({ scope: { repos: [{ id: "a", name: "app" }], tickets: null } });
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("title")).toMatch(/Scoped access/);
  });
});
