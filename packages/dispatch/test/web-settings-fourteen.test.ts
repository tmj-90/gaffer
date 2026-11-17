// @vitest-environment jsdom
//
// The Settings page draws the fourteen settings and nothing else. The data it renders is
// the REAL GET /api/settings body (settingsReport over a temp settings.json, through the
// runner's own config), so the page is tested against what the API actually sends:
//   - one control per setting (GAFFER_MODE is the dial), no control for an old knob;
//   - each "What this sets" lists the values that setting derives, with their figures;
//   - an env-locked setting is read-only and says why;
//   - the "Overridden from the environment" list;
//   - the migration callout and its removal act (nothing removed before the confirm);
//   - secrets masked; Save sends only what changed.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDerivedSettings, settingsReport, SETTING_DEFS } from "../src/api/settings.js";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const SLACK = "https://hooks.slack.com/services/T0/B0/page-secret-token";

const ISOLATION = {
  provider: "docker",
  available: true,
  required: true,
  optedOut: false,
  missing: "",
  fix: "",
};

let dirs: string[] = [];
/** The real GET /api/settings body for this settings.json and operator environment. */
function reportFor(file: Record<string, string>, opEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wg-web-fourteen-"));
  dirs.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify(file));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, ...opEnv };
  resetDerivedSettings(env);
  return { ...settingsReport(env, join(dir, "settings.json")), isolation: ISOLATION };
}

let PLAIN: ReturnType<typeof reportFor>;
let OLD: ReturnType<typeof reportFor>;
let REFUSED: ReturnType<typeof reportFor>;
beforeAll(() => {
  PLAIN = reportFor(
    {
      GAFFER_MODE: "graduated",
      GAFFER_DAILY_BUDGET_USD: "5",
      GAFFER_EFFORT: "large",
      GAFFER_NOTIFY: `desktop,${SLACK}`,
    },
    { GAFFER_TESTING: "on", GAFFER_MAX_TURNS: "12" },
  );
  OLD = reportFor({
    GAFFER_MODE: "autonomous",
    AUTO_MERGE: "0",
    GAFFER_TICK_TIMEOUT: "99999",
    GAFFER_NOTIFY_SLACK_URL: SLACK,
    FOO: "x",
  });
  REFUSED = reportFor({ GAFFER_CONCURRENCY: " 3", GAFFER_MODE: "lite" });
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

let served: unknown;
let posts: { url: string; body: Record<string, unknown> }[] = [];
let postReply: (url: string) => Response = () =>
  new Response(JSON.stringify({ ...(served as object), written: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function stubFetch(): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return postReply(url);
      }
      if (url.includes("/api/settings")) {
        return new Response(JSON.stringify(served), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/cost"))
        return new Response(JSON.stringify({ today_usd: 1.25, total_usd: 40 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

function mountShell(hash = "#/settings"): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(report: unknown, hash?: string): Promise<void> {
  served = report;
  mountShell(hash);
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}${Math.random()}`);
  for (let i = 0; i < 4; i++) await tick();
}
const row = (key: string) => document.querySelector(`#set-${key}`) as HTMLElement;
const submit = async () => {
  (document.querySelector(".settings-form") as HTMLFormElement).requestSubmit();
  await tick();
  await tick();
};

describe("web: the Settings page carries the fourteen", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("one control per setting (the mode is the dial), and none for an old knob", async () => {
    await boot(PLAIN);
    const ids = [...document.querySelectorAll("[id^='set-']")].map((n) => n.id.slice(4)).sort();
    expect(ids).toEqual(SETTING_DEFS.map((d) => d.key).sort());
    expect(document.querySelectorAll(".setting-row").length).toBe(13);
    expect(document.querySelector("#set-GAFFER_MODE.dial")).not.toBeNull();
    for (const old of ["AUTO_MERGE", "REVIEW_MODE", "GAFFER_TICK_TIMEOUT", "SANDBOX_PROVIDER"])
      expect(document.querySelector(`#set-${old}`), old).toBeNull();
    // The only switch on the page's settings is Notify's desktop banner.
    const switches = [...document.querySelectorAll(".settings-form input[type=checkbox]")];
    expect(switches.length).toBe(1);
    expect(switches[0]!.closest("#set-GAFFER_NOTIFY")).not.toBeNull();
  });

  it("each setting says where its value came from, in words", async () => {
    await boot(PLAIN);
    expect(row("GAFFER_EFFORT").querySelector(".setting-src")?.textContent).toBe("set here");
    expect(row("GAFFER_LANDING").querySelector(".setting-src")?.textContent).toBe("default");
    expect(document.querySelector(".ti-setting")?.textContent).toMatch(/Graduated · set here/);
  });

  it("each What this sets lists every value its setting derives, with the figure in force", async () => {
    await boot(PLAIN);
    for (const s of PLAIN.settings) {
      const names = PLAIN.derived.filter((d) => d.setting === s.key).map((d) => d.name);
      const box = document.querySelector(`.what-sets[data-setting="${s.key}"]`);
      if (!names.length) {
        expect(box, s.key).toBeNull();
        continue;
      }
      expect(box, s.key).not.toBeNull();
      const shown = [...box!.querySelectorAll("li")].map((li) => (li as HTMLElement).dataset.name);
      expect(shown, s.key).toEqual(names);
    }
    const tt = document.querySelector(
      '.what-sets[data-setting="GAFFER_EFFORT"] li[data-name="GAFFER_TICK_TIMEOUT"]',
    )!;
    const figure = PLAIN.derived.find((d) => d.name === "GAFFER_TICK_TIMEOUT")!.value;
    expect(tt.querySelector(".ws-value")?.textContent).toBe(figure);
    expect(tt.querySelector(".ws-why")?.textContent).toBe("GAFFER_EFFORT=large");
  });

  it("an env-locked setting is read-only, says the environment sets it, and has no editor", async () => {
    await boot(PLAIN);
    const r = row("GAFFER_TESTING");
    expect(r.classList.contains("is-locked")).toBe(true);
    expect(r.querySelector(".badge.env-locked")?.textContent).toMatch(/set by the environment/);
    expect(r.querySelector("input, select")).toBeNull();
    expect(r.querySelector(".setting-locked-value")?.textContent).toBe("on");
  });

  it("the override list names each derived value the environment sets", async () => {
    await boot(PLAIN);
    const panel = document.querySelector("#settings-overrides")!;
    expect(panel).not.toBeNull();
    const text = panel.textContent || "";
    expect(text).toMatch(/GAFFER_MAX_TURNS/);
    expect(text).toMatch(/12/);
    expect(text).toMatch(/GAFFER_EFFORT/);
    expect(panel.querySelector("a[href$='docs/CONFIG-ADVANCED.md']")).not.toBeNull();
  });

  it("budget: the caps with spend so far; data location shown with how to change it", async () => {
    await boot(PLAIN);
    expect(row("GAFFER_DAILY_BUDGET_USD").querySelector(".setting-spent")?.textContent).toMatch(
      /Spent today \(UTC\): \$1\.25/,
    );
    expect(row("GAFFER_BUDGET_USD").querySelector(".setting-spent")?.textContent).toMatch(/\$40/);
    const data = row("GAFFER_DATA");
    expect(data.querySelector("input")).toBeNull();
    expect(data.textContent).toMatch(/export GAFFER_DATA/);
  });

  it("a notify URL is never on the page; it shows set, with its host", async () => {
    await boot(PLAIN);
    expect(document.body.innerHTML).not.toContain("page-secret-token");
    const slack = row("GAFFER_NOTIFY").querySelector('[data-channel="slack"]')!;
    expect(slack.textContent).toMatch(/Set · hooks\.slack\.com/);
  });

  it("Save sends only what changed: a segmented choice and a budget, never the notify URLs", async () => {
    await boot(PLAIN);
    const small = row("GAFFER_EFFORT").querySelector('input[value="small"]') as HTMLInputElement;
    small.checked = true;
    small.dispatchEvent(new Event("change", { bubbles: true }));
    const usd = row("GAFFER_DAILY_BUDGET_USD").querySelector("input") as HTMLInputElement;
    usd.value = "7";
    usd.dispatchEvent(new Event("input", { bubbles: true }));
    await submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      settings: { GAFFER_EFFORT: "small", GAFFER_DAILY_BUDGET_USD: "7" },
    });
  });

  it("removing the Slack URL sends a notify change, never a URL", async () => {
    await boot(PLAIN);
    const remove = [...row("GAFFER_NOTIFY").querySelectorAll('[data-channel="slack"] button')].find(
      (b) => b.textContent === "Remove",
    ) as HTMLButtonElement;
    remove.click();
    await submit();
    expect(posts[0]!.body).toEqual({ settings: {}, notify: { slack: null } });
  });

  it("the dial is the mode: raising it previews the mode's table, shows Go/No-Go, saves only GAFFER_MODE", async () => {
    await boot(PLAIN);
    const up = document.querySelector('.dial-input[value="autonomous"]') as HTMLInputElement;
    up.checked = true;
    up.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    const table = document.querySelector(".ti-table")!;
    expect(table.textContent).toMatch(/AUTO_MERGE/);
    const am = [...table.querySelectorAll("tr")].find((tr) =>
      /AUTO_MERGE/.test(tr.textContent || ""),
    )!;
    expect([...am.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["0", "1"]);
    expect(document.querySelector(".gng")).not.toBeNull();
    await submit();
    expect(posts[0]!.body).toEqual({ settings: { GAFFER_MODE: "autonomous" } });
  });

  it("a refused value is marked on its row from the server's 422", async () => {
    postReply = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Not saved: Daily budget (USD) is not a dollar amount.",
            details: {
              invalid: [
                {
                  key: "GAFFER_DAILY_BUDGET_USD",
                  label: "Daily budget (USD)",
                  problem: "is not a dollar amount",
                },
              ],
            },
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    try {
      await boot(PLAIN);
      const usd = row("GAFFER_DAILY_BUDGET_USD").querySelector("input") as HTMLInputElement;
      usd.value = "abc";
      usd.dispatchEvent(new Event("input", { bubbles: true }));
      await submit();
      await tick();
      expect(row("GAFFER_DAILY_BUDGET_USD").querySelector(".setting-error")?.textContent).toMatch(
        /is not a dollar amount/,
      );
      expect(usd.getAttribute("aria-invalid")).toBe("true");
    } finally {
      postReply = () =>
        new Response(JSON.stringify({ ...(served as object), written: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    }
  });

  it("the isolation posture is a read-only line in Safety", async () => {
    await boot(PLAIN);
    const line = document.querySelector("#grp-safety .settings-isolation") as HTMLElement;
    expect(line.dataset.state).toBe("available");
    expect(line.querySelector("input, select, button")).toBeNull();
  });
});

describe("web: the migration callout and its removal act", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("no callout when settings.json holds only the fourteen", async () => {
    await boot(PLAIN);
    expect(document.querySelector("#settings-migration")).toBeNull();
  });

  it("lists each old key, the setting that decides it, and which reading is in force", async () => {
    await boot(OLD);
    const box = document.querySelector("#settings-migration")!;
    expect(box).not.toBeNull();
    const text = box.textContent || "";
    expect(text).toMatch(/old settings in settings\.json are now decided by/);
    expect(text).toMatch(/GAFFER_TICK_TIMEOUT=1800 beats Effort large/);
    expect(text).toMatch(/old notify URL keeps receiving events/);
    const rowOf = (k: string) =>
      [...box.querySelectorAll("tr")].find((tr) => tr.querySelector("th")?.textContent === k)!;
    expect(rowOf("AUTO_MERGE").textContent).toMatch(/GAFFER_MODE/);
    expect(rowOf("AUTO_MERGE").textContent).toMatch(/Differs: the old value is in force/);
    expect(rowOf("GAFFER_TICK_TIMEOUT").textContent).toMatch(/the setting's value is in force/);
    expect(rowOf("FOO").textContent).toMatch(/never a setting/);
    expect(box.innerHTML).not.toContain("page-secret-token");
  });

  it("the confirm says, for each stricter old key, that removing it makes the factory looser", async () => {
    // An old per-ticket time limit stricter than Effort large is in force today; the
    // person removing it must read that the factory gets looser, key by key.
    await boot(reportFor({ GAFFER_EFFORT: "large", GAFFER_TICK_TIMEOUT: "1800", AUTO_MERGE: "1" }));
    (document.querySelector(".mig-start") as HTMLButtonElement).click();
    const confirm = document.querySelector(".mig-confirm") as HTMLElement;
    const items = [...confirm.querySelectorAll(".mig-drop li")];
    const tt = items.find((li) => /GAFFER_TICK_TIMEOUT/.test(li.textContent ?? ""))!;
    expect(tt.textContent).toMatch(/Looser after removal/);
    expect(tt.textContent).toMatch(/GAFFER_EFFORT then decides it/);
    const am = items.find((li) => /AUTO_MERGE/.test(li.textContent ?? ""))!;
    expect(am.textContent).not.toMatch(/Looser/);
    expect(confirm.querySelector(".mig-loosens-lede")!.textContent).toMatch(
      /makes the factory looser/,
    );
  });

  it("the removal act shows exactly what it drops, and posts only after the confirm", async () => {
    await boot(OLD);
    const start = document.querySelector(".mig-start") as HTMLButtonElement;
    const confirm = document.querySelector(".mig-confirm") as HTMLElement;
    expect(confirm.hidden).toBe(true);
    start.click();
    expect(confirm.hidden).toBe(false);
    const dropped = [...confirm.querySelectorAll(".mig-drop code")]
      .map((c) => c.textContent)
      .sort();
    expect(dropped).toEqual(OLD.cleanup.drop.map((d) => d.key).sort());
    // Nothing rewritten: no rewrite list, and no stray "null" text in its place.
    expect(confirm.textContent).not.toMatch(/null/);
    expect(confirm.querySelector(".mig-rewrite")).toBeNull();
    expect(posts).toHaveLength(0);
    (document.querySelector(".mig-remove") as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/\/api\/settings\/remove-old-keys$/);
    expect(posts[0]!.body).toEqual({
      drop: OLD.cleanup.drop.map((d) => d.key),
      rewrite: [],
      digest: OLD.cleanup.digest,
    });
  });

  it("a stored value the runner refuses: a red callout in its words, and the act rewrites it", async () => {
    await boot(REFUSED);
    const err = document.querySelector(".settings-config-error")!;
    expect(err.textContent).toMatch(/refuses this settings\.json/);
    expect(err.textContent).toMatch(/GAFFER_CONCURRENCY/);
    (document.querySelector(".mig-start") as HTMLButtonElement).click();
    expect(document.querySelector(".mig-rewrite")?.textContent).toMatch(
      /GAFFER_CONCURRENCY “ 3” becomes “3”/,
    );
  });
});

describe("web: routing and layout", () => {
  beforeEach(() => {
    stubFetch();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("an unknown #/ address renders the 404 page with one way back", async () => {
    await boot(PLAIN, "#/no-such-page");
    const view = document.querySelector(".view-error")!;
    expect(view.querySelector("h1")?.textContent).toBe("No page at #/no-such-page");
    expect(view.querySelector('a.btn.primary[href="#/overview"]')).not.toBeNull();
  });

  it("the boot room's column may shrink, so a phone with the dial raised does not scroll sideways", () => {
    const css = readFileSync(
      path.resolve(process.cwd(), "src/api/web/css/views/settings.css"),
      "utf8",
    );
    const rule = /\.boot-main \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    // The new controls wrap rather than push the page wide.
    expect(css).toMatch(/\.seg-choice \{[^}]*flex-wrap:\s*wrap/);
  });
});
