// @vitest-environment jsdom
//
// DOM test for the brownfield wiring in the SPA "Plan a build" panel:
// when the user picks "Extend existing" and selects a scope node, the panel
// resolves that node's target repo NAME (via GET /scope/nodes/:id) and includes
// `context.repo` in the POST /plan-build payload so the existing-repo
// (brownfield) decompose path is reachable from the UI.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const NODES = [{ id: "node-1", name: "Checkout", type: "product" }];
// The node's repos: a write target should be preferred for the brownfield repo.
const NODE_REPOS = [
  { name: "checkout-web", default_access: "read" },
  { name: "checkout-api", default_access: "write" },
];

let lastPlanPost: unknown = null;

function stubFetch(): void {
  lastPlanPost = null;
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

      if (url.includes("/plan-build") && method === "POST") {
        lastPlanPost = JSON.parse(String(init?.body ?? "{}"));
        return json({ phase: "clarify", questions: ["Anything else?"] });
      }
      // GET /scope/nodes/:id → repos for the chosen extend node.
      if (/\/scope\/nodes\/[^/]+$/.test(url)) return json({ node: NODES[0], repos: NODE_REPOS });
      if (url.includes("/scope/nodes")) return json({ nodes: NODES });
      if (url.includes("/tickets")) return json({ tickets: [] });
      return json({});
    }),
  );
}

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = "#/epics";
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web: Plan-a-build brownfield (extend passes target repo)", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("includes context.repo (a write target) when extending a scope node", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();

    // Open the Plan-a-build panel.
    const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Plan a build"),
    )!;
    trigger.click();
    await tick(); // lets the nodes fetch settle so the extend picker has options

    // Switch to "Extend existing".
    const extendRadio = document.querySelector(
      'input[name="pb-mode"][value="extend"]',
    ) as HTMLInputElement;
    expect(extendRadio).not.toBeNull();
    extendRadio.checked = true;
    extendRadio.dispatchEvent(new Event("change"));
    await tick();

    // Choose the scope node → triggers the GET /scope/nodes/:id repo resolution.
    const sel = document.querySelector(
      'select[aria-label="Scope node or epic to extend"]',
    ) as HTMLSelectElement;
    expect(sel).not.toBeNull();
    sel.value = "node-1";
    sel.dispatchEvent(new Event("change"));
    await tick(); // resolveExtendRepo()

    // Type a brief and send the first turn.
    const input = document.querySelector(".pb-input") as HTMLTextAreaElement;
    input.value = "add a coupon field";
    const form = document.querySelector(".pb-composer") as HTMLFormElement;
    form.requestSubmit();
    await tick();
    await tick();

    expect(lastPlanPost).not.toBeNull();
    const body = lastPlanPost as { context?: { mode: string; repo?: string } };
    expect(body.context?.mode).toBe("extend");
    // The write repo (checkout-api) is preferred as the brownfield target.
    expect(body.context?.repo).toBe("checkout-api");
  });
});
