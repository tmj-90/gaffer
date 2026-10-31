// @vitest-environment jsdom
//
// SECRET-BEARING SETTINGS in the dashboard (external review #5). The API never sends a
// webhook URL back; the Settings view shows a masked field — whether it is set and the
// URL's host — with Replace (type a new value, never see the old one) and Remove. An
// untouched secret is never part of the Save payload.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const SETTINGS = [
  {
    key: "GAFFER_NOTIFY_SLACK_URL",
    value: "",
    effective: "",
    source: "file",
    envLocked: false,
    type: "string",
    group: "notifications",
    label: "Slack webhook URL",
    secret: true,
    configured: true,
    host: "hooks.slack.com",
  },
  {
    key: "GAFFER_NOTIFY_WEBHOOK_URL",
    value: "",
    effective: "",
    source: "default",
    envLocked: false,
    type: "string",
    group: "notifications",
    label: "Webhook URL",
    secret: true,
    configured: false,
    host: null,
  },
  {
    key: "MAX_TICKS",
    value: "20",
    effective: "20",
    source: "file",
    envLocked: false,
    type: "int",
    group: "budget",
    label: "Max ticks (run)",
  },
];

let posts: Array<{ settings: Record<string, string> }> = [];

function stubFetch(): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/settings") && method === "POST") {
        posts.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(
          JSON.stringify({ settings: SETTINGS, written: [], rejected: [], ignored: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/settings")) {
        return new Response(JSON.stringify({ settings: SETTINGS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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
  location.hash = "#/settings";
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const row = (key: string) =>
  Array.from(document.querySelectorAll(".setting-row")).find(
    (r) => r.querySelector(".setting-key")?.textContent === key,
  ) as HTMLElement;
async function save(): Promise<void> {
  (document.querySelector(".settings-form") as HTMLFormElement).requestSubmit();
  await tick();
  await tick();
}

describe("web: secret settings are masked with a Replace action", () => {
  beforeEach(() => {
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows set/host only, never a value input with the secret, and an untouched secret is not saved", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    const slack = row("GAFFER_NOTIFY_SLACK_URL");
    const masked = slack.querySelector(".setting-secret") as HTMLElement;
    expect(masked.textContent).toContain("Set · hooks.slack.com");
    expect(masked.getAttribute("aria-label")).toBe(
      "Slack webhook URL is set for hooks.slack.com; the value is hidden.",
    );
    const input = slack.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.hidden).toBe(true);
    expect(input.value).toBe("");
    expect(row("GAFFER_NOTIFY_WEBHOOK_URL").querySelector(".setting-secret")!.textContent).toBe(
      "Not set",
    );
    (row("MAX_TICKS").querySelector('input[type="number"]') as HTMLInputElement).value = "30";
    await save();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.settings).toEqual({ MAX_TICKS: "30" });
  });

  it("Replace sends the newly typed value; Remove sends an empty value", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    const slack = row("GAFFER_NOTIFY_SLACK_URL");
    const [replace, remove] = Array.from(slack.querySelectorAll("button"));
    expect(replace!.textContent).toBe("Replace");
    replace!.click();
    const input = slack.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.hidden).toBe(false);
    input.value = "https://hooks.slack.com/services/NEW";
    await save();
    expect(posts.at(-1)!.settings).toEqual({
      GAFFER_NOTIFY_SLACK_URL: "https://hooks.slack.com/services/NEW",
    });
    expect(remove!.textContent).toBe("Remove");
  });

  it("Remove clears the secret", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await tick();
    const slack = row("GAFFER_NOTIFY_SLACK_URL");
    const remove = Array.from(slack.querySelectorAll("button")).find(
      (b) => b.textContent === "Remove",
    )!;
    remove.click();
    await save();
    expect(posts.at(-1)!.settings).toEqual({ GAFFER_NOTIFY_SLACK_URL: "" });
  });
});
