/* global document */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// UI regression against a LIVE Gaffer dashboard with the stub worker wired in.
// Driven by scripts/ui-regression/run.sh — see its header for setup. Env:
//   BASE   dashboard origin (default http://127.0.0.1:8797)
//   TOKEN  the dashboard bearer token ($GAFFER_DATA/dashboard-token)
//   REPO_PATH  the sample repo to onboard      OUT  screenshot/results dir
// Flows: login → overview → onboard repo → create ticket → mark ready → poll for
// work (stub delivery) → review + approve → merge → done → suggest work (product
// owner) → every view renders → SSE live refresh. Captures console errors + failed
// requests + screenshots. Exits 1 on any hard failure.
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
const TOKEN = process.env.TOKEN;
const REPO_PATH = process.env.REPO_PATH;
const OUT = process.env.OUT ?? "./shots";
mkdirSync(OUT, { recursive: true });

const RUN_TAG = `run-${Date.now().toString(36)}`;
const results = [];
const consoleErrors = [];
const failedRequests = [];
const ok = (m) => {
  results.push(["ok", m]);
  console.log("  ok   " + m);
};
const bad = (m) => {
  results.push(["FAIL", m]);
  console.log("  FAIL " + m);
};
const note = (m) => {
  results.push(["note", m]);
  console.log("  note " + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: "Bearer " + TOKEN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parse = () => {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  };
  return { status: res.status, json: parse() };
}
async function waitFor(fn, label, ms = 60000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(every);
  }
}
let shotN = 0;
async function shot(page, name) {
  shotN += 1;
  await page.screenshot({
    path: `${OUT}/${String(shotN).padStart(2, "0")}-${name}.png`,
    fullPage: true,
  });
}

// Browser: PLAYWRIGHT_CHROMIUM=<path to a chrome/chromium binary> (e.g. from `npx playwright install chromium`
// or a system Chromium); with no path playwright-core's default channel resolution is used.
const launchOpts = { args: ["--no-sandbox"] };
if (process.env.PLAYWRIGHT_CHROMIUM) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
// The dashboard pulls Google Fonts (external, blocked by this sandbox's proxy CA) — abort it so
// the run isn't skewed; noted separately as an observation for a local-first product.
await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
page.on("requestfailed", (req) => {
  if (!/fonts\.g/.test(req.url()))
    failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
});
page.on("response", (res) => {
  if (res.status() >= 400 && !res.url().includes("/api/memory/"))
    failedRequests.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
});

try {
  // ── 1. login via ?token= (the documented first-run path) ──────────────────
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "load" });
  await page.waitForSelector("#app", { timeout: 15000 });
  const url1 = page.url();
  url1.includes("token=")
    ? bad(`token still in URL after adoption: ${url1}`)
    : ok("token adopted from ?token= and scrubbed from the URL");
  await page.waitForFunction(
    () => document.querySelector("#app")?.textContent?.length > 200,
    null,
    { timeout: 15000 },
  );
  const overviewText = await page.textContent("#app");
  /cycle time|throughput|flow/i.test(overviewText)
    ? ok("Overview renders the headline metrics")
    : bad("Overview did not render metrics: " + overviewText.slice(0, 200));
  await shot(page, "overview-empty");

  // ── 2. onboard the sample repo from the Memory view ───────────────────────
  await page.goto(`${BASE}/#/memory`, { waitUntil: "load" });
  await sleep(700);
  await page.click('button:has-text("Onboard a repo")');
  await page.waitForSelector('input[name="onboard-path"]', { timeout: 15000 });
  ok("Memory view: 'Onboard a repo' opens the onboard sheet");
  await page.fill('input[name="onboard-path"]', REPO_PATH);
  await page.click('.sheet.open button[type="submit"]:has-text("Onboard")');
  ok("Memory view: onboard form submitted for " + REPO_PATH);
  const repo = await waitFor(
    async () => {
      const r = await api("GET", "/repositories");
      return (r.json.repositories || []).find(
        (x) => x.local_path === REPO_PATH || x.name === "taskflow-mini",
      );
    },
    "repo registered by onboard",
    120000,
    2000,
  );
  ok(`repo registered via onboard: ${repo.name} (default_branch=${repo.default_branch})`);
  // Digest lands via the memory CLI; the model analysis is a stub here, so accept either a digest or the honest empty state.
  await page.goto(`${BASE}/#/memory`, { waitUntil: "load" });
  await sleep(1500);
  await shot(page, "memory-after-onboard");
  const memText = await page.textContent("#app");
  /taskflow-mini/i.test(memText)
    ? ok("Memory view lists the onboarded repo")
    : bad("Memory view does not list taskflow-mini");

  // Set the repo's test/lint commands so the DoD gate has something to run (via UI if present).
  await page.goto(`${BASE}/#/repo/${encodeURIComponent(repo.id)}`, { waitUntil: "load" });
  await sleep(800);
  await shot(page, "repo-detail");
  const repoView = await page.textContent("#app");
  /taskflow-mini/.test(repoView) ? ok("Repo detail view renders") : bad("Repo detail view empty");
  const testCmdInput = await page.$('input[name="test_command"], input[placeholder*="test" i]');
  if (testCmdInput) {
    await testCmdInput.fill("npm test");
    const lintInput = await page.$('input[name="lint_command"], input[placeholder*="lint" i]');
    if (lintInput) await lintInput.fill("npm run lint");
    const save = await page.$('button:has-text("Save")');
    if (save) {
      await save.click();
      await sleep(800);
      ok("Repo detail: test/lint commands saved through the UI");
    } else note("Repo detail: found command inputs but no Save button — set via API");
  } else {
    note(
      "Repo detail view exposes no test/lint command inputs — setting gate commands via API (UI gap)",
    );
  }
  const after = (await api("GET", "/repositories")).json.repositories.find((x) => x.id === repo.id);
  if (!after.test_command) {
    const r = await api("PATCH", `/repos/${repo.id}`, {
      test_command: "npm test",
      lint_command: "npm run lint",
    });
    if (r.status >= 300) {
      const r2 = await api("POST", `/repos/${repo.id}/commands`, {
        test_command: "npm test",
        lint_command: "npm run lint",
      });
      r2.status < 300
        ? note("gate commands set via POST /repos/:id/commands")
        : note(
            `could not set gate commands via API (${r.status}/${r2.status}); DoD will run with no gates`,
          );
    } else note("gate commands set via PATCH /repos/:id");
  }

  // ── 3. create a ticket through the Create view ────────────────────────────
  await page.goto(`${BASE}/#/create`, { waitUntil: "load" });
  await page.waitForSelector('input[placeholder="Short, action-oriented title"]', {
    timeout: 15000,
  });
  await page.fill(
    'input[placeholder="Short, action-oriented title"]',
    `Add clearDone helper to the task list (${RUN_TAG})`,
  );
  await page.fill(
    "textarea",
    "Users need to drop completed tasks. Add clearDone(list) with a unit test.",
  );
  // "Repos & scope": pick the repo in the "Add a repo…" select (access stays `write`) and press Add.
  const attached = await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => /taskflow-mini/.test(o.textContent || "")),
    );
    if (!sel) return false;
    const opt = [...sel.options].find((o) => /taskflow-mini/.test(o.textContent || ""));
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  if (attached) {
    await page.click('button:has-text("Add")');
    await sleep(400);
    const txt = await page.textContent("#app");
    /taskflow-mini/.test(txt) && !/No repos attached yet/.test(txt)
      ? ok("Create view: attached taskflow-mini (write) via the repo select + Add")
      : bad("Create view: Add did not attach the repo");
  } else note("Create view: 'Add a repo…' select does not list taskflow-mini");
  await page.click('button:has-text("Create ticket")');
  const ticket = await waitFor(
    async () => {
      const r = await api("GET", "/tickets");
      const list = r.json.tickets || r.json || [];
      return (Array.isArray(list) ? list : []).find((t) => t.title.includes(RUN_TAG));
    },
    "ticket created",
    20000,
    500,
  );
  ok(`ticket #${ticket.number} created through the Create view (status=${ticket.status})`);
  await sleep(800);
  await shot(page, "ticket-created");

  // Guard A: a ticket needs ≥1 AC to be readied. Add an AC (with a machine check) via the ticket view if the UI offers it.
  await page.goto(`${BASE}/#/ticket/${ticket.id}`, { waitUntil: "load" });
  await sleep(800);
  const acInput = await page.$(
    'input[placeholder*="criterion" i], input[placeholder*="acceptance" i], textarea[placeholder*="criterion" i]',
  );
  if (acInput) {
    await acInput.fill("clearDone removes completed tasks and is covered by a test");
    const checkInput = await page.$('input[name="check_command"]');
    if (checkInput) {
      await checkInput.fill("npm test");
      ok("Ticket view: check command entered in the AC form (machine-checkable AC via UI)");
    } else note("Ticket view: no check-command input in the AC form");
    const addAc = await page.$(
      'button:has-text("Add AC"), button:has-text("Add criterion"), button:has-text("Add")',
    );
    if (addAc) {
      await addAc.click();
      await sleep(600);
      ok("Ticket view: acceptance criterion added through the UI");
    } else note("Ticket view: AC input found but no Add button — added via API");
  } else note("Ticket view exposes no AC input — adding the acceptance criterion via API (UI gap)");
  const acs = (await api("GET", `/tickets/${ticket.id}`)).json;
  const acCount = (acs.acceptanceCriteria || acs.acceptance_criteria || []).length;
  if (acCount === 0) {
    const r = await api("POST", `/tickets/${ticket.id}/acceptance-criteria`, {
      text: "clearDone removes completed tasks and is covered by a test",
      check_command: "npm test",
    });
    r.status < 300
      ? note("machine-checkable AC (check_command: npm test) added via API")
      : bad(`could not add AC via API: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  // Mark ready from the ticket view.
  await page.goto(`${BASE}/#/ticket/${ticket.id}`, { waitUntil: "load" });
  await sleep(600);
  const readyBtn = await page.$('button:has-text("Mark ready")');
  if (readyBtn) {
    await readyBtn.click();
    await sleep(1000);
    ok("Ticket view: 'Mark ready' clicked");
  } else {
    note("'Mark ready' button not visible on the ticket view — readying via API");
    await api("POST", `/tickets/${ticket.id}/ready`);
  }
  const readied = await waitFor(
    async () =>
      (await api("GET", `/tickets/${ticket.id}`)).json.ticket?.status === "ready" ? true : null,
    "ticket ready",
    15000,
    500,
  );
  readied && ok(`ticket #${ticket.number} is ready`);
  await shot(page, "ticket-ready");

  // ── 4. Poll for work: the Work view's button runs one tick with the stub agent ─
  await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
  await page.waitForSelector('button:has-text("Poll for work")', { timeout: 15000 });
  await shot(page, "work-board-ready");
  await page.click('button:has-text("Poll for work")');
  ok("Work view: 'Poll for work' clicked (spawns one live tick)");
  const delivered = await waitFor(
    async () => {
      const t = (await api("GET", `/tickets/${ticket.id}`)).json.ticket;
      return ["in_review", "blocked", "refining", "ready_for_merge", "done", "paused"].includes(
        t?.status,
      )
        ? t
        : null;
    },
    "tick to finish",
    240000,
    3000,
  );
  if (delivered.status === "in_review")
    ok(`stub delivery landed in review (#${ticket.number} → in_review)`);
  else bad(`delivery ended in '${delivered.status}' instead of in_review`);
  const view = (await api("GET", `/tickets/${ticket.id}`)).json;
  const acRows = view.acceptanceCriteria || view.acceptance_criteria || [];
  const checked = acRows.find((a) => a.check_command);
  if (checked) {
    checked.status === "satisfied" && checked.verified_by === "runner:check"
      ? ok(
          `machine-checkable AC ran in the worktree and passed (verified_by=${checked.verified_by})`,
        )
      : bad(
          `checked AC not runner-verified: status=${checked.status} verified_by=${checked.verified_by}`,
        );
  }
  // SSE: the Work board should have refreshed itself (no manual reload) — the card moved to Review.
  await sleep(2500);
  const boardText = await page.textContent("#app");
  /clearDone/.test(boardText)
    ? ok("Work board still shows the ticket after the live refresh")
    : bad("ticket vanished from the board");
  await shot(page, "work-board-after-tick");

  // ── 5. Review: server-computed diff, arm + confirm approve ────────────────
  await page.goto(`${BASE}/#/review`, { waitUntil: "load" });
  await page.waitForSelector("#app", { timeout: 15000 });
  await waitFor(
    async () => (await page.textContent("#app")).includes("clearDone"),
    "review view lists the ticket",
    15000,
    500,
  );
  ok("Review view lists the delivered ticket");
  const diffOk = await waitFor(
    async () => {
      const txt = await page.textContent("#app");
      return /helper[0-9]+\(list\)/.test(txt) ? true : null;
    },
    "server diff rendered in the review view",
    30000,
    1000,
  ).catch(() => null);
  diffOk
    ? ok("Review view renders the server-computed diff (shows the stub's added function)")
    : bad("Review view never rendered the diff");
  await shot(page, "review-diff");
  const approveBtn = await page.$('button:has-text("Approve")');
  if (!approveBtn) bad("no Approve button on the review view");
  else {
    const disabled = await approveBtn.isDisabled();
    disabled ? note("Approve button disabled at first paint (diff still loading) — waiting") : null;
    await waitFor(
      async () => (!(await approveBtn.isDisabled()) ? true : null),
      "approve enabled",
      30000,
      500,
    );
    await approveBtn.click();
    const armedLabel = await approveBtn.textContent();
    /confirm/i.test(armedLabel)
      ? ok("Approve is a two-step control: first click ARMS ('Confirm merge')")
      : bad(`first click did not arm (label='${armedLabel}')`);
    await approveBtn.click();
    ok("Approve confirmed");
  }
  const merged = await waitFor(
    async () => {
      const t = (await api("GET", `/tickets/${ticket.id}`)).json.ticket;
      return ["ready_for_merge", "done"].includes(t?.status) ? t : null;
    },
    "approval to land",
    30000,
    1000,
  );
  ok(`ticket #${ticket.number} → ${merged.status} after approval`);
  const done = await waitFor(
    async () => {
      const t = (await api("GET", `/tickets/${ticket.id}`)).json.ticket;
      return t?.status === "done" ? t : null;
    },
    "merge runner to mark done",
    120000,
    3000,
  ).catch(() => null);
  done
    ? ok(`merge runner landed the branch: #${ticket.number} is done`)
    : bad("ticket never reached done after approval (merge runner)");
  await shot(page, "review-after-approve");

  // ── 6. Product owner: Suggest work ────────────────────────────────────────
  await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
  await page.click('button:has-text("Suggest work")');
  await page.waitForSelector('button:has-text("Run product-owner")', { timeout: 10000 });
  const picked = await page.evaluate((name) => {
    const sheet = document.querySelector(".sheet.open");
    const sel =
      sheet &&
      [...sheet.querySelectorAll("select")].find((s) =>
        [...s.options].some((o) => o.value === name),
      );
    if (!sel) return false;
    sel.value = name;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, repo.name);
  picked
    ? ok("Suggest work: target repo selected in the sheet's Repository select")
    : note("Suggest work: repo select not found in the sheet");
  await shot(page, "suggest-work-sheet");
  await page.click('button:has-text("Run product-owner")');
  ok("Suggest work: product-owner run requested");
  const run = await waitFor(
    async () => {
      const r = await api("GET", "/api/runs");
      const runs = [...(r.json.active || []), ...(r.json.recent || []), ...(r.json.runs || [])];
      return runs.find((x) => /product/i.test(x.kind || x.type || "")) || null;
    },
    "product-owner run to appear",
    30000,
    1000,
  ).catch(() => null);
  run
    ? ok(`product-owner run recorded (id=${run.id}, status=${run.status})`)
    : bad("no product-owner run appeared in /api/runs");
  await sleep(4000);
  await shot(page, "after-suggest-work");
  await page.keyboard.press("Escape"); // close the sheet — an open sheet suppresses auto-refresh by design
  await sleep(300);

  // ── 7. every other view renders without console errors ────────────────────
  for (const v of ["overview", "health", "epics", "factory", "specs", "settings", "hidden"]) {
    const before = consoleErrors.length;
    await page.goto(`${BASE}/#/${v}`, { waitUntil: "load" });
    await sleep(900);
    const txt = (await page.textContent("#app")) || "";
    txt.trim().length > 50 && consoleErrors.length === before
      ? ok(`view '${v}' renders (${txt.trim().length} chars, no console errors)`)
      : bad(
          `view '${v}' problem: len=${txt.trim().length} newErrors=${consoleErrors.slice(before).join(" | ")}`,
        );
    await shot(page, `view-${v}`);
  }

  // ── 8. SSE live refresh: a ticket created out-of-band appears on the board without reload
  await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
  await sleep(1500);
  await api("POST", "/tickets", {
    title: "Live-stream smoke ticket",
    description: "created via API while the board is open",
  });
  const live = await waitFor(
    async () =>
      (await page.textContent("#app")).includes("Live-stream smoke ticket") ? true : null,
    "board to pick up the new ticket via SSE",
    8000,
    500,
  ).catch(() => null);
  live
    ? ok("SSE: the board refreshed itself within ~2s of an out-of-band ticket creation")
    : bad("SSE: board did not refresh within 8s (interval fallback is 3s+)");
  await shot(page, "work-live-refresh");
} catch (err) {
  bad("harness error: " + (err?.stack || err));
  await shot(page, "error").catch(() => {});
} finally {
  await browser.close();
}

console.log("\n== console errors ==");
for (const e of consoleErrors) console.log("  " + e.slice(0, 300));
console.log("== failed requests ==");
for (const f of failedRequests) console.log("  " + f.slice(0, 300));
const fails = results.filter((r) => r[0] === "FAIL").length;
writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ results, consoleErrors, failedRequests }, null, 2),
);
console.log(
  `\nUI regression: ${results.filter((r) => r[0] === "ok").length} ok, ${fails} FAIL, ${results.filter((r) => r[0] === "note").length} notes; console errors=${consoleErrors.length}; failed requests=${failedRequests.length}`,
);
process.exit(fails > 0 ? 1 : 0);
