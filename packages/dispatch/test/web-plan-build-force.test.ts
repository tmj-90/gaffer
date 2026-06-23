// @vitest-environment jsdom
//
// DOM test for the "Build the tickets now" escape in the SPA "Plan a build" panel
// (src/api/web/app.js). The conversation must never dead-end: a primary "Build the
// tickets" button is surfaced throughout the chat, and pressing it POSTs the turn
// with forcePlan:true so the decomposer stops clarifying and returns a plan now.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

interface PlanPost {
  brief: string;
  forcePlan?: boolean;
}

let planPosts: PlanPost[] = [];

function stubFetch(): void {
  planPosts = [];
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
        const body = JSON.parse(String(init?.body ?? "{}")) as PlanPost;
        planPosts.push(body);
        // A force-plan turn yields a plan; a normal turn keeps clarifying.
        return body.forcePlan
          ? json({
              phase: "plan",
              plan: { epic: { name: "Forced epic" }, tickets: [{ title: "t", dependsOn: [] }] },
            })
          : json({ phase: "clarify", questions: ["Anything else?"] });
      }
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
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

describe("web: Plan-a-build 'Build the tickets now' escape (no dead-end)", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the 'Build the tickets' button and POSTs forcePlan:true when pressed", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();

    // Open the Plan-a-build panel.
    const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Plan a build"),
    )!;
    trigger.click();
    await tick();

    // The escape button is rendered throughout the conversation.
    const forceBtn = document.querySelector("button.pb-force") as HTMLButtonElement;
    expect(forceBtn).not.toBeNull();
    expect(forceBtn.textContent).toContain("Build the tickets");

    // Send a first (clarifying) turn so there's a brief + history to plan from.
    const input = document.querySelector(".pb-input") as HTMLTextAreaElement;
    input.value = "a web app that tracks gym workouts";
    const form = document.querySelector(".pb-composer") as HTMLFormElement;
    form.requestSubmit();
    await tick();
    await tick();

    expect(planPosts).toHaveLength(1);
    expect(planPosts[0]!.forcePlan).toBeUndefined(); // normal turn carries no forcePlan

    // Now press "Build the tickets" — it forces a plan WITHOUT new input.
    (document.querySelector("button.pb-force") as HTMLButtonElement).click();
    await tick();
    await tick();

    expect(planPosts).toHaveLength(2);
    expect(planPosts[1]!.forcePlan).toBe(true);
    expect(planPosts[1]!.brief).toBe("a web app that tracks gym workouts");

    // The returned plan renders for review (the create path is unchanged).
    expect(document.querySelector(".pb-proposal")).not.toBeNull();
    expect(document.body.textContent).toContain("Forced epic");
  });

  it("emphasises the escape button once the conversation runs several turns deep", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();

    const trigger = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Plan a build"),
    )!;
    trigger.click();
    await tick();

    const input = document.querySelector(".pb-input") as HTMLTextAreaElement;
    const form = document.querySelector(".pb-composer") as HTMLFormElement;

    // First turn: not yet emphasised.
    input.value = "build me a thing";
    form.requestSubmit();
    await tick();
    await tick();
    expect(document.querySelector("button.pb-force")!.classList.contains("pb-force-strong")).toBe(
      false,
    );

    // A couple more clarifying answers push it past the emphasis threshold (3 turns).
    for (let i = 0; i < 2; i++) {
      input.value = `answer ${i}`;
      form.requestSubmit();
      await tick();
      await tick();
    }
    expect(document.querySelector("button.pb-force")!.classList.contains("pb-force-strong")).toBe(
      true,
    );
  });
});
