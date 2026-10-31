// @vitest-environment jsdom
//
// "Plan a build" — requirements agreed while the planner asked its questions reach the
// acceptance contract. The planner asks how long a link lives; the human answers "Links
// expire after 30 minutes"; the proposed tickets omit expiry. The proposal must list the
// answer, flag that no proposed criterion covers it, and confirming must POST it on the
// epic (agreed_requirements) with the plan session id — unless the human unticks it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const QUESTION = "How long should a shortened link stay valid?";
const ANSWER = "Links expire after 30 minutes";
const PLAN = {
  epic: { name: "Shortener", description: "A link shortener" },
  tickets: [
    {
      title: "Shorten a URL",
      description: "POST /links returns a short code",
      acceptanceCriteria: ["POST /links returns a short code", "GET /:code redirects"],
      dependsOn: [],
    },
  ],
};

let epicPosts: Array<Record<string, unknown>> = [];
let planTurns = 0;

function stubFetch(): void {
  epicPosts = [];
  planTurns = 0;
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
      if (url.includes("/plan-build") && method === "POST") {
        planTurns++;
        return planTurns === 1
          ? json({ phase: "clarify", questions: [QUESTION] })
          : json({ phase: "plan", plan: PLAN });
      }
      if (url.endsWith("/plan-sessions") && method === "POST")
        return json({ session: { id: "sess-1", status: "active", messages_json: "[]" } }, 201);
      if (url.includes("/plan-sessions")) return json({ session: null });
      if (url.includes("/epics") && method === "POST") {
        epicPosts.push(JSON.parse(String(init?.body ?? "{}")));
        return json({ epic_node_id: "n1", ticket_numbers: [1, 2] }, 201);
      }
      if (url.includes("/scope/nodes")) return json({ nodes: [] });
      if (url.includes("/repositories")) return json({ repositories: [] });
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
async function settle(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

async function say(text: string): Promise<void> {
  const input = document.querySelector(".pb-input") as HTMLTextAreaElement;
  input.value = text;
  (document.querySelector(".pb-composer") as HTMLFormElement).requestSubmit();
  await settle();
}

async function toProposal(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.includes("Plan a build"))!
    .click();
  await settle();
  await say("a link shortener");
  await say(ANSWER);
}

describe("web: Plan a build — agreed requirements", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("lists the answer, flags it as uncovered, and confirming posts it to the epic", async () => {
    await toProposal();
    const section = document.querySelector(
      'section[aria-label="Requirements agreed while planning"]',
    );
    expect(section).not.toBeNull();
    const item = section!.querySelector(".pb-agreed-item")!;
    expect(item.textContent).toContain(ANSWER);
    expect(item.textContent).toContain(QUESTION);
    expect(item.classList.contains("is-uncovered")).toBe(true);
    expect(item.textContent).toContain("No proposed ticket's criteria cover this");
    const box = item.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-label")).toBe(`Add “${ANSWER}” to the acceptance criteria`);

    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create as draft"))!
      .click();
    await settle(6);
    expect(epicPosts).toHaveLength(1);
    const body = epicPosts[0]!;
    expect((body.epic as { agreed_requirements: unknown }).agreed_requirements).toEqual([
      { question: QUESTION, answer: ANSWER },
    ]);
    expect(body.plan_session_id).toBe("sess-1");
  });

  it("an unticked requirement is NOT posted (the human's explicit choice)", async () => {
    await toProposal();
    const box = document.querySelector(".pb-agreed-item input[type=checkbox]") as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create as draft"))!
      .click();
    await settle(6);
    expect((epicPosts[0]!.epic as { agreed_requirements: unknown }).agreed_requirements).toEqual(
      [],
    );
  });
});
