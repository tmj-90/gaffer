/* global document, window, getComputedStyle */
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
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// playwright-core is resolved with CommonJS rules (NOT a bare ESM import) so the
// copy run.sh installs under $UI_REGRESS_OUT/node_modules is found: ESM ignores
// NODE_PATH, so a bare `import "playwright-core"` only works when the package is
// already in the repo's node_modules.
const requireFrom = createRequire(
  path.join(process.env.PW_CORE_ROOT || process.cwd(), "package.json"),
);
const { chromium } = requireFrom("playwright-core");
// axe-core (WCAG 2.1 A/AA audit) is injected as an init script — CSP is
// `script-src 'self'`, so an inline <script> would be refused; init scripts run
// through the driver before the page's own and are not subject to the page CSP.
const AXE_SOURCE = (() => {
  try {
    return readFileSync(requireFrom.resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
})();

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

// WCAG 2.1 A + AA audit of the rendered view. critical/serious violations fail the
// run; moderate/minor are notes. axe reports colour contrast it cannot compute
// (text over a pseudo-element or an image) as "incomplete" rather than failing,
// which let 1.8:1 chips through at desktop width (axe-gate-blind-contrast). So:
// decorative ::before/::after are neutralised for the audit, and more than a
// small budget of incomplete colour-contrast nodes fails too, naming them.
const CONTRAST_INCOMPLETE_BUDGET = 3;
async function auditA11y(pg, v, width) {
  // Inject axe into THIS document. Hash routing keeps one document alive, so an
  // init script (new documents only) never lands; a string evaluate runs as an
  // indirect eval in the page's global scope, is not subject to the page CSP, and
  // defines `axe` once.
  if (!(await pg.evaluate(() => typeof globalThis.axe !== "undefined"))) {
    await pg.evaluate(AXE_SOURCE);
  }
  const res = await pg
    .evaluate(async () => {
      const neutral = document.createElement("style");
      neutral.textContent = "*::before,*::after{content:none!important}";
      document.head.appendChild(neutral);
      try {
        // eslint-disable-next-line no-undef
        const r = await axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        const violations = r.violations.map((x) => {
          const n0 = x.nodes[0];
          const data = n0?.any?.[0]?.data ?? n0?.all?.[0]?.data ?? null;
          const detail =
            data && typeof data === "object" && "contrastRatio" in data
              ? ` fg=${data.fgColor} bg=${data.bgColor} ratio=${data.contrastRatio} need=${data.expectedContrastRatio}`
              : "";
          return {
            id: x.id,
            impact: x.impact,
            nodes: x.nodes.length,
            sample: `${n0?.target?.[0] ?? ""}${detail}`,
          };
        });
        // Count what axe could not measure because of what is BEHIND the text
        // (pseudo-elements, images, gradients, overlap). Content it declines to
        // judge as text (a lone "·", "✓" or crest letter) and SVG chart text (its
        // <svg> is an image to axe; chart text uses the ink tokens) are not budgeted.
        const inc = r.incomplete.find((x) => x.id === "color-contrast");
        const incomplete = inc
          ? inc.nodes
              .filter((n) => {
                const key = n.any?.[0]?.data?.messageKey;
                if (key === "shortTextContent" || key === "nonBmp") return false;
                const el = document.querySelector(String(n.target?.[0] ?? ""));
                return !(el && el.closest && el.closest("svg"));
              })
              .map((n) => String(n.target?.[0] ?? ""))
          : [];
        return { violations, incomplete };
      } finally {
        neutral.remove();
      }
    })
    .catch((e) => ({
      violations: [{ id: "axe-run-failed", impact: "serious", nodes: 0, sample: String(e) }],
      incomplete: [],
    }));
  const serious = res.violations.filter((x) => x.impact === "critical" || x.impact === "serious");
  const minor = res.violations.filter((x) => !(x.impact === "critical" || x.impact === "serious"));
  const fmt = (xs) => xs.map((x) => `${x.id}[${x.impact}]×${x.nodes} @${x.sample}`).join("; ");
  const tag = `${v}@${width}`;
  serious.length
    ? bad(`a11y '${tag}': ${fmt(serious)}`)
    : ok(
        `a11y '${tag}': no critical/serious WCAG 2.1 A/AA violations${minor.length ? ` (${minor.length} moderate/minor)` : ""}`,
      );
  if (minor.length) note(`a11y '${tag}' moderate/minor: ${fmt(minor)}`);
  if (res.incomplete.length > CONTRAST_INCOMPLETE_BUDGET)
    bad(
      `a11y '${tag}': ${res.incomplete.length} text nodes' contrast could not be measured (budget ${CONTRAST_INCOMPLETE_BUDGET}): ${res.incomplete.slice(0, 6).join(", ")}`,
    );
  else if (res.incomplete.length)
    note(`a11y '${tag}': contrast unmeasured for ${res.incomplete.join(", ")}`);
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
  /team sheet/i.test(overviewText) && /tactics board/i.test(overviewText)
    ? ok("Overview renders the team sheet and the tactics board")
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

  // ── 2b. ratify a lore DRAFT from the Memory view (run.sh seeded one for taskflow-mini) ──
  // Drafts used to be approvable only with `memory review` in a terminal. The card's
  // status filter narrows to drafts, Approve POSTs /api/memory/lore/:id/approve
  // (the server runs the memory CLI), and the record comes back active.
  try {
    await page.goto(`${BASE}/#/memory/taskflow-mini`, { waitUntil: "load" });
    await page.waitForSelector("select.lore-filter-status", { timeout: 15000 });
    await page.selectOption("select.lore-filter-status", "draft");
    await page.waitForSelector(".lore-row[data-status='draft'] button.lore-approve", {
      timeout: 15000,
    });
    const draftRow = page.locator(".lore-row[data-status='draft']").first();
    const draftTitle = (await draftRow.locator(".lore-title").textContent()) || "";
    /UI regression draft/i.test(draftTitle)
      ? ok("Memory view: the seeded lore draft is listed under status=draft")
      : bad(`Memory view: unexpected draft row "${draftTitle}"`);
    await shot(page, "memory-lore-draft");
    await draftRow.locator("button.lore-approve").click();
    // The drafts-only page re-fetches and the row leaves it…
    await page.waitForFunction(
      () => !document.querySelector(".lore-row[data-status='draft'] button.lore-approve"),
      null,
      { timeout: 15000 },
    );
    ok("Memory view: Approve removed the draft from the drafts-only page");
    // …and the API now reports it active for that repo.
    const active = await waitFor(
      async () => {
        const r = await api("GET", "/api/memory/lore?repo=taskflow-mini&status=active");
        return (r.json.lore || []).find((l) => /UI regression draft/i.test(l.title || ""));
      },
      "approved lore is active",
      15000,
      500,
    );
    active && active.status === "active"
      ? ok(`lore draft approved from the dashboard → active (${active.id})`)
      : bad("approved lore did not come back active");
    await shot(page, "memory-lore-approved");
  } catch (e) {
    bad("Memory view lore ratification: " + (e && e.message ? e.message : String(e)));
  }

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
  // #/create now leads with Plan a build (its composer is the page's first textarea);
  // the single-ticket form is the "One ticket" section beside it.
  await page.fill(
    "#one-ticket textarea",
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
    await page.click('#one-ticket button:has-text("Add")');
    await sleep(400);
    const txt = await page.textContent("#app");
    /taskflow-mini/.test(txt) && !/No repos attached yet/.test(txt)
      ? ok("Create view: attached taskflow-mini (write) via the repo select + Add")
      : bad("Create view: Add did not attach the repo");
  } else note("Create view: 'Add a repo…' select does not list taskflow-mini");
  await page.click('#one-ticket button:has-text("Create ticket")');
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
    // The submit button of the AC form itself — the ticket view has other "Add …"
    // forms (attach repo) earlier in the DOM, so a text-only fallback hits the wrong one.
    const addAc = await page.$(
      'form:has(input[placeholder*="criterion" i]) button[type="submit"], button:has-text("Add AC")',
    );
    if (addAc) {
      await addAc.click();
      // The view re-renders asynchronously after the POST — wait for the AC to land
      // server-side before deciding whether the API fallback is needed.
      const landed = await waitFor(
        async () => {
          const v = (await api("GET", `/tickets/${ticket.id}`)).json;
          const list = v.acceptanceCriteria || v.acceptance_criteria || [];
          return list.length > 0 ? list : null;
        },
        "AC added via the ticket view",
        10000,
        300,
      ).catch(() => null);
      if (landed) {
        const withCheck = landed.find((a) => a.check_command);
        withCheck
          ? ok(
              `Ticket view: acceptance criterion added through the UI with check_command='${withCheck.check_command}'`,
            )
          : ok("Ticket view: acceptance criterion added through the UI (no check command carried)");
      } else bad("Ticket view: 'Add AC' did not create a criterion within 10s");
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

  // ── 5a. review-scroll-jumps-to-top: a background refresh must not throw the
  //        reader back to the top of the diff they are reading. On a short
  //        viewport, scroll to the bottom of the queue, then make the factory emit
  //        an unrelated event (the live stream schedules a refresh) and check the
  //        scroll position held. Before the fix the refresh rebuilt every card with
  //        "Loading diff…" placeholders, the page shrank and scrollY clamped to 0.
  {
    await page.setViewportSize({ width: 1400, height: 420 });
    await sleep(500);
    const y0 = await page.evaluate(() => {
      const se = document.scrollingElement;
      se.scrollTop = se.scrollHeight;
      return se.scrollTop;
    });
    if (y0 < 150) note(`review scroll check: queue only ${y0}px taller than the viewport`);
    // Mark the view on screen: an unchanged queue must not be rebuilt at all
    // (review-n-plus-one-refresh), which is what keeps the reader's place.
    const diffReads = [];
    const onReq = (req) => {
      if (/\/tickets\/[^/]+\/diff/.test(req.url())) diffReads.push(req.url());
    };
    page.on("request", onReq);
    await page.evaluate(() => {
      document.querySelector("#app > .view").__scrollMark = true;
    });
    await api("POST", "/tickets", {
      title: "Unrelated ticket during review (scroll check)",
      description: "created via API while the reviewer is scrolled down",
    });
    await sleep(3500); // > the stream's 400ms debounce + a render
    const y1 = await page.evaluate(() => document.scrollingElement.scrollTop);
    const kept = await page.evaluate(
      () => document.querySelector("#app > .view")?.__scrollMark === true,
    );
    page.off("request", onReq);
    Math.abs(y1 - y0) <= 50
      ? ok(`Review keeps the reader's scroll across a live refresh (${y0} → ${y1})`)
      : bad(`Review scroll jumped on a live refresh: ${y0} → ${y1}`);
    kept && diffReads.length === 0
      ? ok("Review: an unchanged queue is not rebuilt or re-diffed by a live refresh")
      : bad(
          `Review: a live refresh rebuilt the unchanged queue (view replaced=${!kept}, diff reads=${diffReads.length})`,
        );
    await page.setViewportSize({ width: 1400, height: 1000 });
    await sleep(300);
  }

  // A LOCATOR, not an ElementHandle: the review list re-renders under the live
  // stream while the diff loads, and a handle taken before that detaches
  // ("Element is not attached to the DOM"). A locator re-resolves on every action.
  const approveBtn = page
    .locator('button:has-text("Approve"), button:has-text("Confirm merge")')
    .first();
  if ((await approveBtn.count()) === 0) bad("no Approve button on the review view");
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
  if (merged.status === "ready_for_merge") {
    // AUTO_MERGE is off by default: a human approval waits in Ready for merge until
    // someone presses Merge now. The ticket page's action is the way in.
    ok("Auto-merge on approval is off: the approval waits in Ready for merge");
    // Let the review page finish its own approve handler first (it pins the address
    // to #/review/<id> after the API answers); navigating under it lost the ticket
    // page to that late replaceState on a slow runner.
    await page.waitForSelector(".rv-done-t", { timeout: 15000 }).catch(() => null);
    await page.goto(`${BASE}/#/ticket/${ticket.id}`, { waitUntil: "load" });
    const mergeNow = 'button:has-text("Merge now")';
    const seen = await page.waitForSelector(mergeNow, { timeout: 15000 }).catch(() => null);
    if (!seen) {
      // Diagnose before retrying: what did the page show instead?
      const head = (await page.textContent(".view").catch(() => "")) || "";
      note(
        `ticket page had no Merge now after 15s (url=${page.url()}); view head: ${head.slice(0, 160)}`,
      );
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(mergeNow, { timeout: 15000 });
    }
    await page.click(mergeNow);
    ok("Ticket page: Merge now pressed (runs the merge runner)");
  }
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

  // ── 6b. Settings → Access: mint a named credential (token shown once), revoke it ──
  await page.goto(`${BASE}/#/settings`, { waitUntil: "load" });
  await sleep(900);
  const whoami = (await page.textContent('[data-testid="access-whoami"]').catch(() => "")) || "";
  /Signed in as .* via the shared token/.test(whoami)
    ? ok("Settings: Access panel names the signed-in actor and the shared token")
    : bad(`Settings: Access panel whoami missing/unexpected: ${whoami.slice(0, 120)}`);
  const pName = await page.$('input[name="principal-name"]');
  if (pName) {
    await pName.fill("ci-reviewer");
    await page.selectOption('select[name="principal-capability"]', "read");
    await page.click('form.access-form button[type="submit"]');
    await sleep(800);
    const minted = (await page.inputValue('[data-testid="access-token"]').catch(() => "")) || "";
    minted.startsWith("gfp_") && minted.length > 40
      ? ok("Settings: creating a principal shows its gfp_ token once")
      : bad(
          `Settings: no one-time token after creating a principal (got '${minted.slice(0, 12)}…')`,
        );
    await shot(page, "settings-principal-created");
    // The new principal authenticates as its own actor, read-scoped.
    const who = await fetch(`${BASE}/api/whoami`, {
      headers: { Authorization: `Bearer ${minted}` },
    });
    const whoJson = who.ok ? await who.json() : null;
    whoJson && whoJson.capability === "read" && whoJson.actor && whoJson.actor.id === "ci-reviewer"
      ? ok("API: the minted token authenticates as principal ci-reviewer (read)")
      : bad(`API: minted token whoami unexpected: ${who.status} ${JSON.stringify(whoJson)}`);
    const denied = await fetch(`${BASE}/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "should be refused" }),
    });
    denied.status === 403
      ? ok("API: the read principal is refused on a mutation (403)")
      : bad(`API: read principal mutation returned ${denied.status}`);
    // Two-step revoke from the list, then the token is dead.
    const revokeBtn = page.locator(
      '.access-item:has-text("ci-reviewer") button:has-text("Revoke")',
    );
    await revokeBtn.click();
    await page
      .locator('.access-item:has-text("ci-reviewer") button:has-text("Confirm revoke")')
      .click();
    await sleep(900);
    const rowTxt =
      (await page.textContent('.access-item:has-text("ci-reviewer")').catch(() => "")) || "";
    /revoked/.test(rowTxt)
      ? ok("Settings: revoking a principal marks it revoked in the list")
      : bad(`Settings: principal row after revoke: ${rowTxt.slice(0, 120)}`);
    const dead = await fetch(`${BASE}/api/whoami`, {
      headers: { Authorization: `Bearer ${minted}` },
    });
    dead.status === 401
      ? ok("API: the revoked token is refused (401)")
      : bad(`API: revoked token returned ${dead.status}`);
  } else bad("Settings: no principal-name input (Access panel missing)");

  // ── 6c. Settings → Idle loops: turn the maintenance lane on through the UI, then prove an
  //        idle tick finds the planted god-file, files + promotes the ticket, and the next
  //        tick delivers it with the runner verifying the oracle criterion. ──
  await page.goto(`${BASE}/#/settings`, { waitUntil: "load" });
  await sleep(900);
  if (!(await page.$('[data-testid="maintenance-toggle"]'))) {
    bad("Settings: Idle loops panel has no maintenance toggle");
  } else {
    // The boot room folds its long sections; open the idle-loop scans as a user
    // would (its summary), then work its switches.
    if (!(await page.$("#idle-loops[open]"))) await page.click("#idle-loops > summary");
    // The switch inputs are visually hidden (the track is the control), so a user
    // toggles them by clicking the label — do the same rather than forcing the input.
    const setSwitch = async (selector, on) => {
      const input = page.locator(selector);
      if ((await input.isChecked()) === on) return;
      const label = input.locator("xpath=ancestor::label[1]");
      await label.scrollIntoViewIfNeeded();
      await label.click();
      if ((await input.isChecked()) !== on) bad(`could not toggle ${selector} to ${on}`);
    };
    // Only the tech-debt lane, so the scheduler's choice is deterministic.
    await setSwitch('[data-testid="maintenance-toggle"]', true);
    for (const key of [
      "idle_security_hotspot",
      "idle_coverage",
      "idle_test_quality",
      "idle_type_quality",
      "idle_documentation",
      "idle_dependencies",
      "idle_feature_backlog",
    ]) {
      await setSwitch(`[data-testid="idle-loop-${key}"]`, false);
    }
    await setSwitch('[data-testid="idle-loop-idle_tech_debt"]', true);
    await setSwitch('[data-testid="self-improve-toggle"]', true);
    await setSwitch(`.idle-self-improve .target-picker-check:has-text("${repo.name}") input`, true);
    // The onboarded repo is medium risk by default; the gate's ceiling must admit it.
    await page.selectOption('select[name="self-improve-max-risk"]', "medium");
    const statusTxt = (await page.textContent('[data-testid="idle-status"]').catch(() => "")) || "";
    /runs ONE of the 1 enabled lane/.test(statusTxt) && /promoted to ready/.test(statusTxt)
      ? ok("Settings: Idle loops status line reflects the live selection (1 lane, promotion on)")
      : bad(`Settings: Idle loops status line unexpected: ${statusTxt.slice(0, 160)}`);
    await shot(page, "settings-idle-loops");
    await page.click('button:has-text("Save idle loops")');
    await sleep(1200);
    const idle = (await api("GET", "/api/idle-loops")).json.idle_loops;
    idle &&
    idle.maintenance &&
    idle.maintenance.enabled === true &&
    idle.selfImprove &&
    idle.selfImprove.enabled === true &&
    idle.selfImprove.repos.includes(repo.name) &&
    idle.selfImprove.maxRisk === "medium" &&
    idle.loops.find((l) => l.key === "idle_tech_debt")?.enabled === true
      ? ok("Settings: Save wrote maintenance + tech-debt lane + self-improve gate to crew.yaml")
      : bad(`Settings: idle-loops after save unexpected: ${JSON.stringify(idle).slice(0, 300)}`);

    // Idle tick: nothing is ready (ticket #1 is done), so Poll runs the maintenance lane.
    await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
    await page.waitForSelector('button:has-text("Poll for work")', { timeout: 15000 });
    await page.click('button:has-text("Poll for work")');
    ok("Work view: 'Poll for work' clicked on an empty queue (maintenance lane tick)");
    const debt = await waitFor(
      async () => {
        const rows = (await api("GET", "/tickets")).json;
        const list = Array.isArray(rows) ? rows : rows.tickets || [];
        return (
          list.find((t) => /^Tech-debt hotspots/.test(t.title) && t.status === "ready") || null
        );
      },
      "tech-debt ticket to be filed and promoted to ready",
      120000,
      2000,
    ).catch(() => null);
    if (!debt) bad("maintenance lane did not file + promote a tech-debt ticket within 120s");
    else {
      ok(
        `maintenance lane filed the god-file finding and self-improve promoted it (#${debt.number} ready)`,
      );
      const debtView = (await api("GET", `/tickets/${debt.id}`)).json;
      const acs = debtView.acceptanceCriteria || debtView.acceptance_criteria || [];
      acs.length === 1 && acs[0].check_command
        ? ok(
            `tech-debt ticket carries the behaviour-preserving oracle (check_command='${acs[0].check_command}')`,
          )
        : bad(`tech-debt ticket criteria unexpected: ${JSON.stringify(acs).slice(0, 200)}`);
      /src\/legacy\.js/.test(debtView.ticket?.description || "")
        ? ok("the finding names the planted god-file (src/legacy.js)")
        : bad("the finding does not name src/legacy.js");
      await shot(page, "work-board-tech-debt-ready");

      // Second poll: the runner claims the promoted ticket and the stub delivers it.
      await page.click('button:has-text("Poll for work")');
      const delivered2 = await waitFor(
        async () => {
          const t = (await api("GET", `/tickets/${debt.id}`)).json.ticket;
          return ["in_review", "blocked", "refining", "ready_for_merge", "done", "paused"].includes(
            t?.status,
          )
            ? t
            : null;
        },
        "tech-debt ticket delivery to finish",
        240000,
        3000,
      ).catch(() => null);
      if (!delivered2) bad("tech-debt delivery did not finish within 240s");
      else if (delivered2.status !== "in_review")
        bad(`tech-debt delivery ended in '${delivered2.status}' instead of in_review`);
      else {
        ok(`the factory fixed its own finding: #${debt.number} → in_review`);
        const after = (await api("GET", `/tickets/${debt.id}`)).json;
        const oracle = (after.acceptanceCriteria || after.acceptance_criteria || [])[0];
        oracle && oracle.status === "satisfied" && oracle.verified_by === "runner:check"
          ? ok("the runner verified the oracle in the worktree (verified_by=runner:check)")
          : bad(`oracle not runner-verified: ${JSON.stringify(oracle).slice(0, 200)}`);
      }
      await shot(page, "work-board-tech-debt-delivered");
    }
  }

  // ── 6d. the club and the squad: the crest names the club from /api/club, and the
  //        Squad page renames an agent in place (shirt number + display name).
  {
    const club = (await api("GET", "/api/club")).json.club;
    await page.goto(`${BASE}/#/squad`, { waitUntil: "load" });
    await sleep(1200);
    const crestName = ((await page.textContent(".brand-name").catch(() => "")) || "").trim();
    club && crestName.toLowerCase() === String(club.name_effective).toLowerCase()
      ? ok(`crest names the club: '${crestName}' (GET /api/club)`)
      : bad(`crest reads '${crestName}', /api/club says '${club && club.name_effective}'`);
    const agents = (await api("GET", "/api/squad")).json.agents || [];
    const rows = await page.locator(".sq-table tbody tr").count();
    if (!agents.length) note("squad: no agents registered, rename step skipped");
    else if (rows !== agents.length) bad(`squad: ${rows} rows for ${agents.length} agents`);
    else {
      const a0 = agents[0];
      const row = page.locator(`.sq-table tbody tr[data-id="${a0.agent_id}"]`);
      await row.locator("button.sq-rename").click();
      await row.locator("input.sq-name-in").fill("Regression Kev");
      await row.locator("input.sq-no-in").fill("9");
      await row.locator("button.sq-save").click();
      await sleep(800);
      const after = (await api("GET", "/api/squad")).json.agents.find(
        (x) => x.agent_id === a0.agent_id,
      );
      const txt = (await row.textContent()) || "";
      after &&
      after.display_name === "Regression Kev" &&
      after.shirt_number === 9 &&
      /Regression Kev/.test(txt)
        ? ok("squad: an agent renamed inline wears No. 9 as 'Regression Kev'")
        : bad(`squad rename did not land: ${JSON.stringify(after)} row='${txt.slice(0, 120)}'`);
      await shot(page, "squad-renamed");
      // Put it back, so the steps after this read the factory as seeded.
      await api("PATCH", `/api/squad/agents/${a0.agent_id}`, {
        display_name: a0.display_name,
        shirt_number: a0.shirt_number,
      });
    }
  }

  // ── 6e. the Floor: one parcel per open ticket, each a link read as a sentence,
  //        and focusing one shows its number and title in the floor's card.
  {
    const all = (await api("GET", "/tickets")).json.tickets || [];
    const open = all.filter((t) => !["done", "cancelled"].includes(t.status)).length;
    await page.goto(`${BASE}/#/floor`, { waitUntil: "load" });
    await sleep(1200);
    const fl = await page.evaluate(() => {
      const ps = [...document.querySelectorAll("svg.fl-svg a.fl-parcel:not([data-status='done'])")];
      return {
        svg: Boolean(document.querySelector("svg.fl-svg")),
        parcels: new Set(ps.map((a) => a.getAttribute("data-id"))).size,
        unlabelled: ps.filter((a) => !/^#\d+ .+, /.test(a.getAttribute("aria-label") || "")).length,
        // a station past its last slot says "+n" instead of drawing the rest
        more: [...document.querySelectorAll("svg.fl-svg .fl-tag-text")]
          .map((t) => /^\+(\d+)$/.exec(t.textContent || ""))
          .filter(Boolean)
          .reduce((n, m) => n + Number(m[1]), 0),
      };
    });
    fl.svg && fl.unlabelled === 0 && fl.parcels + fl.more === open
      ? ok(`floor: ${fl.parcels} parcels for ${open} open tickets, each a link read as a sentence`)
      : bad(`floor: svg=${fl.svg} parcels=${fl.parcels} open=${open} unlabelled=${fl.unlabelled}`);
    const first = page.locator("svg.fl-svg a.fl-parcel").first();
    if (await first.count()) {
      await first.focus();
      await sleep(150);
      const tipTxt = ((await page.textContent(".fl-tip").catch(() => "")) || "").trim();
      const n = await first.getAttribute("data-n");
      tipTxt.startsWith(`#${n}`)
        ? ok(`floor: focusing parcel #${n} shows its card ("${tipTxt.slice(0, 60)}")`)
        : bad(`floor: focus card for #${n} reads '${tipTxt}'`);
    } else note("floor: no parcel to focus (an empty floor)");
    await shot(page, "floor");
  }

  // ── 6a. work: the board is a visible window with whole-board counts ─────────
  //   The Work view asks /api/board for a window per lane (?limit=), and each lane
  //   head reads the server's total for that lane, not just the cards it loaded.
  {
    const boardReqs = [];
    const onReq = (req) => {
      if (req.url().includes("/api/board")) boardReqs.push(req.url());
    };
    page.on("request", onReq);
    await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
    await sleep(900);
    page.off("request", onReq);
    boardReqs.some((u) => /[?&]limit=\d+/.test(u))
      ? ok("work: the board is fetched as a visible window (?limit=)")
      : bad(`work: board requests carry no window: ${boardReqs.join(" ") || "none"}`);
    const windowed = (await api("GET", "/api/board?limit=1")).json;
    const heads = await page
      .$$eval(".board-col", (els) =>
        els.map((e) => [e.dataset.column, e.querySelector(".board-col-count")?.textContent]),
      )
      .catch(() => []);
    const wrong = heads.filter(
      ([col, n]) => String(windowed?.counts?.columns?.[col] ?? "?") !== String(n),
    );
    heads.length && !wrong.length
      ? ok(`work: every lane head equals the server's count (${heads.length} lanes)`)
      : bad(`work: lane heads disagree with /api/board counts: ${JSON.stringify(wrong)}`);
  }

  // ── 6b. health: flow efficiency claims only agent-working time ──────────────
  //   The merged ticket above has a transition history, so the form guide shows the
  //   flow efficiency as working time and lists where shipped tickets waited (the
  //   merge queue on its own) instead of counting review and the queue as work.
  {
    await page.goto(`${BASE}/#/health`, { waitUntil: "load" });
    await sleep(900);
    const bandLabel =
      (await page.getAttribute(".form-guide .fg-eff .band", "aria-label").catch(() => "")) || "";
    /^Flow efficiency (<1|\d+)% of lead time with an agent working on the ticket$/.test(bandLabel)
      ? ok(`health: flow efficiency says what it measures ("${bandLabel}")`)
      : bad(`health: flow efficiency band reads '${bandLabel}'`);
    const waitRows = await page
      .$$eval(".form-guide .fg-wait dt", (els) => els.map((e) => e.textContent.trim()))
      .catch(() => []);
    waitRows.includes("Waiting to merge") && waitRows.includes("In review or testing")
      ? ok(`health: waiting is shown on its own (${waitRows.join(", ")})`)
      : bad(`health: no waiting breakdown (rows: ${waitRows.join(", ") || "none"})`);
    await shot(page, "health-flow");
  }

  // ── 7. every other view renders without console errors + passes the a11y audit ──
  if (!AXE_SOURCE) note("axe-core not installed — a11y audit skipped");
  for (const v of [
    "overview",
    "work",
    "review",
    "health",
    "epics",
    "factory",
    "specs",
    "settings",
    "hidden",
    "memory",
    "squad",
    "floor",
    `ticket/${ticket.id}`,
    `repo/${encodeURIComponent(repo.id)}`,
  ]) {
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
    if (AXE_SOURCE) await auditA11y(page, v, "1400");
  }

  // ── 7b. layout sweep: every view at phone, tablet and laptop widths ────────
  //   appbar-overflow-760-1565: the header never scrolls the page sideways and its
  //     controls (Search, New, Logout) stay inside the viewport;
  //   mobile-overview-overflow: no view is wider than the viewport, down to 320px;
  //   settings-access-giant-icon: no 24-grid icon renders wider than 48px;
  //   squashed-shirt: no sized svg (agent shirt, repo kit, card) is squeezed below
  //     its drawn aspect ratio by a flex row (the shirt was 0px wide at 320);
  //   hero-banners-below-fold: the first board card / the team sheet are on screen;
  //   axe-gate-blind-contrast: the WCAG audit also runs at 390px.
  {
    const views = [
      "overview",
      "work",
      "review",
      "health",
      "epics",
      "factory",
      "specs",
      "settings",
      "memory",
      "squad",
      "floor",
      `ticket/${ticket.id}`,
      `repo/${encodeURIComponent(repo.id)}`,
    ];
    const sweep = [
      { w: 390, h: 844, views, axe: true },
      { w: 768, h: 1000, views },
      { w: 1024, h: 768, views },
      { w: 1280, h: 800, views },
      { w: 1440, h: 900, views },
      { w: 360, h: 780, views: ["overview", "work", "review", "floor"] },
      { w: 320, h: 640, views: ["overview", "work", "floor"] },
    ];
    for (const { w, h, views: vs, axe: runAxe } of sweep) {
      const c2 = await browser.newContext({ viewport: { width: w, height: h } });
      const p2 = await c2.newPage();
      p2.on("pageerror", (err) => consoleErrors.push(`pageerror@${w}: ${err.message}`));
      await p2.goto(`${BASE}/?token=${TOKEN}#/overview`, { waitUntil: "load" });
      await sleep(900);
      const problems = [];
      for (const v of vs) {
        await p2.goto(`${BASE}/#/${v}`, { waitUntil: "load" });
        await sleep(900);
        const m = await p2.evaluate(() => {
          const vw = window.innerWidth;
          const inView = (sel) => {
            const n = document.querySelector(sel);
            if (!n) return null;
            const r = n.getBoundingClientRect();
            if (!r.width) return null; // not shown at this width
            return r.left >= -1 && r.right <= vw + 1;
          };
          const wide = [...document.querySelectorAll('#app svg[viewBox="0 0 24 24"]')]
            .map((s) => s.getBoundingClientRect().width)
            .filter((x) => x > 48);
          // A shown svg with a width/height attribute keeps its shape.
          const squashed = [...document.querySelectorAll("#app svg[width][height]")]
            .filter((s) => {
              const r = s.getBoundingClientRect();
              const aw = +s.getAttribute("width");
              const ah = +s.getAttribute("height");
              if (!r.height || !aw || !ah) return false;
              return r.width / r.height < (aw / ah) * 0.75;
            })
            .map(
              (s) =>
                `${s.getAttribute("class") || "svg"} ${s.getBoundingClientRect().width.toFixed(1)}px`,
            );
          const pipe = document.querySelector(".pipeline-panel .pipeline");
          const card = document.querySelector(".board-card");
          const sheet = document.getElementById("what-i-own");
          return {
            sw: document.documentElement.scrollWidth,
            vw,
            vh: window.innerHeight,
            search: inView(".cmdk-trigger"),
            newBtn: inView(".btn-new"),
            logout: inView(".logout-btn"),
            wide,
            squashed,
            pipeDisplay: pipe ? getComputedStyle(pipe).display : null,
            card: card ? card.getBoundingClientRect().toJSON() : null,
            sheetTop: sheet ? sheet.getBoundingClientRect().top : null,
            // The Map: a ground card never clips its own words, never runs off the
            // pitch, and the server's implicit "repo:<name>" scope is not a ground.
            grounds: [...document.querySelectorAll(".scope-graph .scope-gnode")]
              .filter((g) => g.getBoundingClientRect().width)
              .flatMap((g) => {
                const r = g.getBoundingClientRect();
                const pitch = g.closest(".graph-scroll, .map-list").getBoundingClientRect();
                const name = g.querySelector(".sg-name")?.textContent || "?";
                const out = [];
                if (g.scrollHeight > g.clientHeight + 1) out.push(`${name} clips its words`);
                if (r.right > pitch.right + 1 || r.left < pitch.left - 1)
                  out.push(`${name} runs off the pitch`);
                if (/^repo:/.test(name)) out.push(`${name} drawn as a ground`);
                return out;
              }),
            // Health: one rule between treatment rows (the li's), not a second on the link.
            doubleRules: [...document.querySelectorAll(".needs-item .ni-link")].filter(
              (a) => parseFloat(getComputedStyle(a).borderTopWidth) > 0,
            ).length,
          };
        });
        const tag = `${v}@${w}`;
        if (m.sw > m.vw) problems.push(`${tag} scrollWidth ${m.sw} > ${m.vw}`);
        for (const k of ["search", "newBtn", "logout"])
          if (m[k] === false) problems.push(`${tag} header ${k} outside the viewport`);
        if (m.wide.length) problems.push(`${tag} ${m.wide.length} icon(s) wider than 48px`);
        if (m.squashed.length)
          problems.push(
            `${tag} ${m.squashed.length} icon(s) squashed: ${m.squashed.slice(0, 3).join(", ")}`,
          );
        if (m.pipeDisplay && m.pipeDisplay !== "flex")
          problems.push(`${tag} dev-flow strip is display:${m.pipeDisplay}`);
        if (v === "work" && m.card) {
          const onScreen = w <= 400 ? m.card.top <= m.vh : m.card.bottom <= m.vh;
          if (!onScreen && (w === 390 || w === 1280 || w === 1440))
            problems.push(`${tag} first board card below the fold (${Math.round(m.card.top)})`);
        }
        if (m.grounds.length) problems.push(`${tag} ${m.grounds.join(", ")}`);
        if (m.doubleRules) problems.push(`${tag} ${m.doubleRules} treatment rows ruled twice`);
        if (v === "overview" && m.sheetTop != null && m.sheetTop > m.vh && w >= 390)
          problems.push(`${tag} team sheet below the fold (${Math.round(m.sheetTop)})`);
        if (runAxe && AXE_SOURCE) await auditA11y(p2, v, String(w));
      }
      problems.length
        ? bad(`layout @${w}px: ${problems.join("; ")}`)
        : ok(
            `layout @${w}px: ${vs.length} views fit (no sideways scroll, header controls on screen, icons sized)`,
          );
      if (w === 1440) await shot(p2, "layout-1440-overview").catch(() => {});
      await c2.close();
    }
  }

  // ── 7c. the a11y gate measures contrast: a planted 1.8:1 chip whose box sits
  //        behind a decorative ::before (which axe alone reports only as
  //        "incomplete") must FAIL. Proves the neutraliser + incomplete budget work.
  if (AXE_SOURCE) {
    await page.goto(`${BASE}/#/overview`, { waitUntil: "load" });
    await sleep(900);
    const caught = await page.evaluate(async () => {
      const host = document.createElement("div");
      host.id = "axe-self-test";
      host.innerHTML =
        '<style>#axe-self-test .chip-x::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,#ffb224,#ffb224)}</style>' +
        '<span class="chip-x" style="position:relative;display:inline-block;padding:4px 8px;background:#ffb224;color:#fff;font-size:12px">review</span>';
      document.getElementById("app").appendChild(host);
      try {
        const neutral = document.createElement("style");
        neutral.textContent = "*::before,*::after{content:none!important}";
        document.head.appendChild(neutral);
        // eslint-disable-next-line no-undef
        const r = await axe.run("#axe-self-test", {
          runOnly: { type: "rule", values: ["color-contrast"] },
        });
        neutral.remove();
        // With the neutraliser the chip's own background is measurable: a violation.
        return r.violations.length > 0;
      } finally {
        host.remove();
      }
    });
    caught
      ? ok("a11y gate self-test: a planted 1.8:1 chip behind a ::before is caught")
      : bad("a11y gate self-test: the planted 1.8:1 chip was NOT caught (contrast is unmeasured)");
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

  // ── 9. A board move through the Move menu (Ready → Draft → Ready): the lane counts
  // follow and the glide's View Transition, skipped by the refresh that follows the
  // move, leaves no uncaught rejection in the console.
  {
    // A ticket of its own, made Ready through the API (the seed has no idle Ready one).
    const made = await api("POST", "/tickets", {
      title: "Board move smoke ticket",
      description: "moved Ready → Draft → Ready through the Move menu",
    });
    const mover = made.json.ticket || made.json;
    if (mover && mover.id)
      await api("POST", `/tickets/${mover.id}/acceptance-criteria`, {
        text: "The card moves and comes back",
      });
    const readied =
      mover && mover.id ? await api("POST", `/tickets/${mover.id}/move`, { to: "ready" }) : null;
    if (!readied || readied.status !== 200) {
      note(`board move: could not make a Ready ticket (HTTP ${readied && readied.status})`);
    } else {
      const num = `#${mover.number}`;
      const errsBefore = consoleErrors.length;
      const laneCount = (col) =>
        page.textContent(`.board-col[data-column="${col}"] .board-col-count`);
      const moveTo = async (lane) => {
        const cardLoc = page.locator(`.board-card:has(.num:text-is("${num}"))`).first();
        await cardLoc.locator("button.card-move-btn").click();
        await page.locator(".movemenu-item", { hasText: lane }).click();
        await sleep(2500);
      };
      await page.goto(`${BASE}/#/work`, { waitUntil: "load" });
      await sleep(1500);
      const draft0 = Number(await laneCount("draft"));
      await moveTo("Draft");
      const draft1 = Number(await laneCount("draft"));
      await moveTo("Ready");
      const draft2 = Number(await laneCount("draft"));
      const newErrs = consoleErrors.slice(errsBefore);
      draft1 === draft0 + 1 && draft2 === draft0 && newErrs.length === 0
        ? ok(`board move: ${num} went to Draft and back, lane counts followed, no console errors`)
        : bad(
            `board move: draft ${draft0}→${draft1}→${draft2}, console errors: ${newErrs.join(" | ")}`,
          );
    }
  }
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
