// @vitest-environment jsdom
//
// DOM test for the brownfield wiring in the SPA "Plan a build" panel. The
// "Extend existing" picker is the shared target selector: it offers BOTH repos
// and scope nodes. Choosing a repo directly carries that repo NAME straight into
// the POST /plan-build context. Choosing a multi-repo scope node expands to a
// repo disambiguator; the chosen repo NAME flows into context.repo so the
// existing-repo (brownfield) decompose path is reachable from the UI.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const NODES = [{ id: "node-1", name: "Checkout", type: "product" }];
const REPOS = [
  { id: "r1", name: "checkout-web" },
  { id: "r2", name: "checkout-api" },
];
// The node links two repos, so the picker asks which one to target.
const NODE_REPOS = [{ name: "checkout-web" }, { name: "checkout-api" }];

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
      // GET /scope/repos?node=:id → the node's linked repos for the picker.
      if (url.includes("/scope/repos")) return json({ repos: NODE_REPOS });
      if (url.includes("/scope/nodes")) return json({ nodes: NODES });
      if (url.includes("/repositories")) return json({ repositories: REPOS });
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

async function openExtend(): Promise<HTMLSelectElement> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();

  const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Plan a build"),
  )!;
  trigger.click();
  await tick(); // lets the nodes + repos fetch settle so the picker has options
  await tick();

  const extendRadio = document.querySelector(
    'input[name="pb-mode"][value="extend"]',
  ) as HTMLInputElement;
  extendRadio.checked = true;
  extendRadio.dispatchEvent(new Event("change"));
  await tick();
  await tick();

  return document.querySelector(".pb-extend-field .target-picker-select") as HTMLSelectElement;
}

async function sendBrief(): Promise<void> {
  const input = document.querySelector(".pb-input") as HTMLTextAreaElement;
  input.value = "add a coupon field";
  const form = document.querySelector(".pb-composer") as HTMLFormElement;
  form.requestSubmit();
  await tick();
  await tick();
}

describe("web: Plan-a-build brownfield (extend targets a repo)", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("carries context.repo when a repo is chosen directly", async () => {
    const sel = await openExtend();
    expect(sel).not.toBeNull();
    // The picker offers repos directly under the "Repos" optgroup.
    sel.value = "repo:checkout-api";
    sel.dispatchEvent(new Event("change"));
    await tick();

    await sendBrief();

    const body = lastPlanPost as { context?: { mode: string; repo?: string } };
    expect(body.context?.mode).toBe("extend");
    expect(body.context?.repo).toBe("checkout-api");
  });

  it("asks which repo to target for a multi-repo node, then carries that repo", async () => {
    const sel = await openExtend();
    sel.value = "node:node-1";
    sel.dispatchEvent(new Event("change"));
    await tick();
    await tick(); // resolve the node's repos → disambiguator appears

    // A second select appears because the node links two repos.
    const repoSel = document.querySelector(
      ".target-picker-reposlot select",
    ) as HTMLSelectElement | null;
    expect(repoSel).not.toBeNull();
    repoSel!.value = "checkout-api";
    repoSel!.dispatchEvent(new Event("change"));
    await tick();

    await sendBrief();

    const body = lastPlanPost as {
      context?: { mode: string; scopeNodeId?: string; repo?: string };
    };
    expect(body.context?.mode).toBe("extend");
    expect(body.context?.scopeNodeId).toBe("node-1");
    expect(body.context?.repo).toBe("checkout-api");
  });
});
