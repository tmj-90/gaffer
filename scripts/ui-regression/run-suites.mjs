/* global document */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// Scenario-suite driver: runs the chosen suites (scripts/ui-regression/suites/*.mjs)
// against the dashboard run-suites.sh started, one browser, one fresh page per
// suite. Prints one summary line per suite and the overall
// "UI scenarios: N ok, N FAIL" line; exits 1 on any FAIL. Env: BASE TOKEN REPO_PATH
// OUT GAFFER_DATA (run-suites.sh sets them); UI_SUITES or argv names the suites.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as L from "./lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
mkdirSync(L.OUT, { recursive: true });

// The order suites run in when none are named (also the order inside a shard).
export const ORDER = [
  "s1-rework",
  "s2-wont-do",
  "s3-blocked",
  "s10-pause",
  "s5-tester",
  "s6-decisions",
  "s12-settings",
  "s13-principals",
  "s9-memory",
  "s14-map",
  "s15-squad-floor",
  "s8-specs",
  "s7-plan",
  "s11-health",
  "s4-autonomy",
  "s16-review-hold",
  "s17-conflict",
  "s12b-idle-lanes",
  "sweep",
];

const available = readdirSync(path.join(HERE, "suites"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""));
const asked = (
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : (process.env.UI_SUITES || "").split(/[\s,]+/)
).filter(Boolean);
const names = asked.length ? asked : ORDER.filter((n) => available.includes(n));
const unknown = names.filter((n) => !available.includes(n));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(", ")} (have: ${available.join(", ")})`);
  process.exit(2);
}

const launchOpts = { args: ["--no-sandbox"] };
if (process.env.PLAYWRIGHT_CHROMIUM) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await L.chromium.launch(launchOpts);

/** Make the onboarded repo + its gate commands exist (each shard is a fresh server). */
async function bootstrap(r) {
  const find = async () =>
    ((await L.api("GET", "/repositories")).json.repositories || []).find(
      (x) => x.local_path === L.REPO_PATH || x.name === "taskflow-mini",
    );
  let repo = await find();
  if (!repo) {
    const o = await L.api("POST", "/repos/onboard", { repo: L.REPO_PATH });
    o.status < 300
      ? r.ok("bootstrap: sample repo onboarding started (POST /repos/onboard)")
      : r.bad(`bootstrap: onboard refused ${o.status} ${JSON.stringify(o.json).slice(0, 200)}`);
    repo = await L.maybe(find, "repo registered", 120000, 2000);
  }
  if (!repo) {
    r.bad("bootstrap: the sample repo never registered");
    return null;
  }
  if (!repo.test_command) {
    const c = await L.api("POST", `/repos/${repo.id}/commands`, {
      test_command: "npm test",
      lint_command: "npm run lint",
    });
    c.status < 300
      ? r.ok("bootstrap: the repo's DoD gate commands are npm test / npm run lint")
      : r.bad(`bootstrap: could not set gate commands (${c.status})`);
  }
  // Wait out the onboard run so its stub calls never interleave with a suite's.
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "onboard run to finish",
    120000,
    2000,
  );
  return (await find()) || repo;
}

/** Leave nothing a later suite's Poll could pick up: no runs, no open tickets. */
async function quiesce(t) {
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "runs to finish",
    300000,
    2000,
  );
  for (const tk of await L.listTickets()) {
    if (L.TERMINAL.includes(tk.status)) continue;
    if (tk.status === "in_progress" && tk.human_owner)
      await L.api("POST", `/tickets/${tk.id}/human-release`, {});
    const r = await L.api("POST", `/tickets/${tk.id}/wont-do`, {
      reason: `scenario cleanup after ${t.suite}`,
    });
    if (r.status >= 300) {
      const m = await L.api("POST", `/tickets/${tk.id}/move`, { to: "draft" });
      if (m.status >= 300)
        console.log(
          `  note [${t.suite}] cleanup could not close #${tk.number} (${tk.status}): ${r.status}/${m.status}`,
        );
    }
  }
}

function makeContext(name, repo) {
  const r = L.makeReporter(name);
  const t = { ...r, suite: name, browser, repo, created: new Set(), seen: new Set() };
  t.page = null;
  t.open = async (opts = {}) => {
    if (t.page)
      await t.page
        .context()
        .close()
        .catch(() => {});
    t.page = await L.openPage(browser, opts);
    return t.page;
  };
  /** Navigate to a route, prove it rendered with no new console errors, audit it once. */
  t.visit = async (route, { axe = true, label, settle = 900, page = t.page } = {}) => {
    const before = page.consoleErrors.length;
    await page.goto(`${L.BASE}/#/${route}`, { waitUntil: "load" });
    await page
      .waitForFunction(
        () => (document.querySelector("#app")?.textContent || "").trim().length > 50,
        null,
        { timeout: 15000 },
      )
      .catch(() => null);
    await L.sleep(settle);
    const key = label || route.replace(/[0-9a-f-]{8,}|\d+$/gi, ":id");
    const errs = page.consoleErrors.slice(before);
    if (errs.length)
      t.bad(`view '${key}' logged console errors: ${errs.join(" | ").slice(0, 300)}`);
    if (!t.seen.has(key)) {
      t.seen.add(key);
      if (!errs.length) t.ok(`view '${key}' renders with no console errors`);
      if (axe) await L.auditA11y(page, `${key}@${page.viewportSize()?.width}`, t);
    }
  };
  /** Press Poll for work on the Work view; answers the toast it raised. */
  t.poll = async () => {
    if (!/#\/work/.test(t.page.url())) await t.visit("work");
    const btn = t.page.locator('button:has-text("Poll for work")').first();
    await btn.waitFor({ timeout: 15000 });
    // Only a toast that appears AFTER this click answers it.
    await L.clearToast(t.page);
    await btn.click();
    return (await L.waitToast(t.page, /./, 15000)) || "";
  };
  /** Approve a delivered ticket from its Review page (two presses: arm, confirm). */
  t.approve = async (tk) => {
    const pg = t.page;
    await t.visit(`review/${tk.id}`, { label: "review/:id" });
    const btn = pg
      .locator('.signoff button:has-text("Approve"), .signoff button:has-text("Confirm merge")')
      .first();
    await L.maybe(
      async () => (!(await btn.isDisabled().catch(() => true)) ? true : null),
      "approve enabled",
      30000,
      500,
    );
    await btn.click();
    await btn.click();
    return L.waitStatus(tk.id, ["in_testing", "ready_for_merge", "done"], 20000, 500);
  };
  /** Drive one Settings row the way an operator does (switch, select or box). */
  t.setSetting = async (key, value) => {
    const pg = t.page;
    const row = pg.locator(`#set-${key}`);
    await row.evaluate((n) => {
      const d = n.closest("details");
      if (d) d.open = true;
      n.scrollIntoView({ block: "center" });
    });
    const cb = row.locator('input[type="checkbox"]');
    if (await cb.count()) {
      const want = value === true || value === "1";
      if ((await cb.isChecked()) !== want) await row.locator("label.switch").click();
      return;
    }
    const sel = row.locator("select");
    if (await sel.count()) return sel.selectOption(String(value));
    return row.locator(".setting-control input").fill(String(value));
  };
  /** Press Save changes; answers the POST /api/settings response body. */
  t.saveSettings = async () => {
    const pg = t.page;
    const resP = pg.waitForResponse(
      (res) => res.url().endsWith("/api/settings") && res.request().method() === "POST",
      { timeout: 15000 },
    );
    await pg.locator('.boot-save button[type="submit"]').click();
    const res = await resP;
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* not json */
    }
    const posted = JSON.parse(res.request().postData() || "{}");
    return { status: res.status(), body, sent: posted.settings ?? posted };
  };
  return t;
}

const all = [];
const summary = [];
const t0all = Date.now();
const boot = L.makeReporter("bootstrap");
let repo = null;
try {
  repo = await bootstrap(boot);
} catch (e) {
  boot.bad("bootstrap harness error: " + (e?.stack || e));
}
all.push(...boot.results.map((x) => ["bootstrap", ...x]));

for (const name of names) {
  const t = makeContext(name, repo);
  const started = Date.now();
  const settingsBefore = L.readSettingsFile();
  try {
    const mod = await import(pathToFileURL(path.join(HERE, "suites", `${name}.mjs`)).href);
    if (!repo && mod.needsRepo !== false)
      t.bad("no onboarded repo (bootstrap failed); suite not run");
    else {
      await t.open();
      await mod.default(t, L);
    }
  } catch (e) {
    t.bad("harness error: " + (e?.stack || e).toString().slice(0, 600));
    if (t.page) await L.shot(t.page, `${name}-error`);
  }
  // Put settings back the way the suite found them (a suite saves through the UI).
  try {
    const now = L.readSettingsFile();
    const back = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(settingsBefore)]))
      if (now[k] !== settingsBefore[k]) back[k] = settingsBefore[k] ?? "";
    if (Object.keys(back).length) await L.putSettings(back);
    await quiesce(t);
  } catch (e) {
    t.note("cleanup: " + e.message);
  }
  if (t.page)
    await t.page
      .context()
      .close()
      .catch(() => {});
  const c = (k) => t.results.filter((x) => x[0] === k).length;
  const secs = Math.round((Date.now() - started) / 1000);
  summary.push(
    `suite ${name}: ${c("ok")} ok, ${c("FAIL")} FAIL, ${c("note")} notes, ${c("skip")} skipped (${secs}s)`,
  );
  all.push(...t.results.map((x) => [name, ...x]));
}
await browser.close();

const n = (k) => all.filter((x) => x[1] === k).length;
writeFileSync(
  `${L.OUT}/results.json`,
  JSON.stringify({ suites: names, summary, results: all }, null, 2),
);
console.log("\n== summary ==");
for (const s of summary) console.log(s);
for (const f of all.filter((x) => x[1] === "FAIL"))
  console.log(`  FAIL [${f[0]}] ${f[2]}`.slice(0, 400));
console.log(
  `\nUI scenarios: ${n("ok")} ok, ${n("FAIL")} FAIL, ${n("note")} notes, ${n("skip")} skipped (${names.length} suites, ${Math.round((Date.now() - t0all) / 1000)}s)`,
);
process.exit(n("FAIL") > 0 ? 1 : 0);
