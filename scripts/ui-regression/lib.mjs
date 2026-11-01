/* global document, window, getComputedStyle */
/* eslint-disable @typescript-eslint/no-unused-expressions -- `cond ? ok(…) : bad(…)` is the assertion idiom of this harness */
// Shared helpers for the scenario suites (scripts/ui-regression/suites/*.mjs), driven
// by run-suites.mjs against the server run-suites.sh starts (the same world as the
// golden path: setup.sh). Nothing here asserts on its own: every check a suite makes
// goes through its reporter (ok / bad / note / skip), whose messages are the
// operator's record of what was proved.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFrom = createRequire(
  path.join(process.env.PW_CORE_ROOT || process.cwd(), "package.json"),
);
export const { chromium } = requireFrom("playwright-core");
export const AXE_SOURCE = (() => {
  try {
    return readFileSync(requireFrom.resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
})();

export const BASE = process.env.BASE ?? "http://127.0.0.1:8798";
export const TOKEN = process.env.TOKEN;
export const REPO_PATH = process.env.REPO_PATH;
export const OUT = process.env.OUT ?? "./shots";
export const GAFFER_DATA = process.env.GAFFER_DATA;
export const ROOT =
  process.env.ROOT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TERMINAL = ["done", "cancelled"];
export const SETTLED = [
  "in_review",
  "blocked",
  "refining",
  "ready_for_merge",
  "done",
  "paused",
  "in_testing",
  "cancelled",
  "failed",
];

// ── reporting ───────────────────────────────────────────────────────────────
export function makeReporter(suite) {
  const results = [];
  const push = (kind, m) => {
    results.push([kind, m]);
    console.log(`  ${kind === "FAIL" ? "FAIL" : kind.padEnd(4)} [${suite}] ${m}`);
  };
  return {
    results,
    ok: (m) => push("ok", m),
    bad: (m) => push("FAIL", m),
    note: (m) => push("note", m),
    skip: (m) => push("skip", m),
    check: (cond, okMsg, badMsg) => (cond ? push("ok", okMsg) : push("FAIL", badMsg)),
  };
}

// ── REST ────────────────────────────────────────────────────────────────────
export async function api(method, p, body, token = TOKEN) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
export async function waitFor(fn, label, ms = 60000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(every);
  }
}
/** waitFor that answers null instead of throwing. */
export const maybe = (fn, label, ms, every) => waitFor(fn, label, ms, every).catch(() => null);

export const ticketView = async (id) => (await api("GET", `/tickets/${id}`)).json;
export const ticketOf = async (id) => (await ticketView(id)).ticket;
export async function listTickets() {
  const r = (await api("GET", "/tickets?limit=1000")).json;
  return Array.isArray(r) ? r : r.tickets || [];
}
export const acsOf = (view) => view.acceptanceCriteria || view.acceptance_criteria || [];
/** Wait until the ticket's status is one of `statuses`; answers the ticket or null. */
export const waitStatus = (id, statuses, ms = 240000, every = 2000) =>
  maybe(
    async () => {
      const t = await ticketOf(id);
      return t && statuses.includes(t.status) ? t : null;
    },
    `ticket ${id} → ${statuses.join("|")}`,
    ms,
    every,
  );

/**
 * Why a ticket a suite polled for never reached the status it waited on, from what
 * the factory itself recorded: the ticket as GET /tickets/:id and the list (by number)
 * report it, the other ready tickets a tick would pick first, the POST /poll-work
 * answer (`poll`, t.lastPoll: polled, reason, pending, the run id), the tail of that
 * run's log and the factory.log lines naming the ticket. One line, for a FAIL
 * message, so a CI failure is diagnosable from the job log alone.
 */
export async function whyStuck(tk, poll) {
  const parts = [];
  const byId = await ticketOf(tk.id).catch(() => null);
  const all = await listTickets().catch(() => []);
  const byNum = all.find((x) => x.number === tk.number);
  parts.push(
    `ticket #${tk.number}: GET /tickets/:id → ${byId ? byId.status : "nothing"}, list by number → ${byNum ? byNum.status : "nothing"}`,
  );
  const others = all
    .filter((x) => x.status === "ready" && x.id !== tk.id)
    .map((x) => `#${x.number}`);
  if (others.length) parts.push(`other ready tickets: ${others.join(" ")}`);
  if (!poll) parts.push("poll: no POST /poll-work answer recorded");
  else {
    const b = poll.body || {};
    parts.push(
      `poll: ${poll.status} polled=${b.polled} ${b.reason ? `reason=${b.reason} ` : ""}readyCount=${b.readyCount} pending=${JSON.stringify(b.pending || {})}`,
    );
    const runId = b.run && b.run.runId;
    if (runId) {
      const r = await fetch(`${BASE}/api/runs/${runId}/log`, {
        headers: { authorization: "Bearer " + TOKEN },
      }).catch(() => null);
      const text = r && r.ok ? await r.text() : "";
      const tail = text
        .split("\n")
        .filter((l) => l.trim())
        .slice(-6);
      parts.push(`run ${runId} log tail: ${tail.length ? tail.join(" ⏎ ") : "(empty or missing)"}`);
    }
  }
  try {
    const re = new RegExp(`#${tk.number}\\b`);
    const lines = readFileSync(path.join(GAFFER_DATA, "factory.log"), "utf8")
      .split("\n")
      .filter((l) => re.test(l))
      .slice(-4);
    parts.push(`factory.log on #${tk.number}: ${lines.length ? lines.join(" ⏎ ") : "(no line)"}`);
  } catch {
    parts.push("factory.log: unreadable");
  }
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 1800);
}

// ── seeding (REST; the UI flows themselves are what the suites drive) ───────
let seq = 0;
export const tag = (s) => `${s}-${Date.now().toString(36)}${(++seq).toString(36)}`;
/**
 * Create a ticket on the sample repo through the API: write access, the given
 * criteria (each {text, check_command?}), optionally readied. Answers the ticket row.
 */
export async function seedTicket(
  ctx,
  { title, description, acs = [], ready = false, repo = true, risk } = {},
) {
  const body = {
    title,
    description: description ?? `Seeded by the ${ctx.suite} scenario suite.`,
    ...(risk ? { risk_level: risk } : {}),
    ...(repo && ctx.repo ? { repoIds: [{ repo_id: ctx.repo.id, access: "write" }] } : {}),
  };
  const made = await api("POST", "/tickets", body);
  const t = made.json.ticket || made.json;
  if (!t || !t.id)
    throw new Error(
      `seed ticket failed: ${made.status} ${JSON.stringify(made.json).slice(0, 200)}`,
    );
  for (const ac of acs) {
    const r = await api(
      "POST",
      `/tickets/${t.id}/acceptance-criteria`,
      typeof ac === "string" ? { text: ac } : ac,
    );
    if (r.status >= 300)
      throw new Error(`seed AC failed: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  if (ready) {
    const r = await api("POST", `/tickets/${t.id}/ready`);
    if (r.status >= 300)
      throw new Error(`seed ready failed: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  ctx.created.add(t.id);
  return (await ticketOf(t.id)) || t;
}

// ── the stub worker's mode file + call record (stub-claude.sh header) ───────
const modeFile = () => path.join(GAFFER_DATA, "stub-mode.json");
export function setStubMode(number, spec) {
  let all = {};
  try {
    all = JSON.parse(readFileSync(modeFile(), "utf8"));
  } catch {
    /* none yet */
  }
  if (spec == null) delete all[String(number)];
  else all[String(number)] = spec;
  writeFileSync(modeFile(), JSON.stringify(all, null, 2));
}
export function stubCalls(filter = {}) {
  const f = path.join(GAFFER_DATA, "stub-calls.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((c) => Object.entries(filter).every(([k, v]) => String(c[k]) === String(v)));
}

// ── settings ────────────────────────────────────────────────────────────────
export async function settingsMap() {
  const r = (await api("GET", "/api/settings")).json;
  const list = Array.isArray(r) ? r : r.settings || [];
  return new Map(list.map((s) => [s.key, s]));
}
/** Write settings through the API (setup/teardown only; suites save through the UI). */
export const putSettings = (values) => api("POST", "/api/settings", { settings: values });
export function readSettingsFile() {
  try {
    return JSON.parse(readFileSync(path.join(GAFFER_DATA, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// ── git on the sample repo ──────────────────────────────────────────────────
export const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

// ── the browser ─────────────────────────────────────────────────────────────
/**
 * A fresh context + page signed in through ?token= (the documented first-run path),
 * with console errors and failed requests captured on it. `token` defaults to the
 * dashboard's shared token.
 */
export async function openPage(
  browser,
  { width = 1400, height = 1000, token = TOKEN, route = "overview" } = {},
) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  page.consoleErrors = [];
  page.failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") page.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => page.consoleErrors.push("pageerror: " + err.message));
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/api/memory/"))
      page.failedRequests.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
  });
  await page.goto(`${BASE}/?token=${token}#/${route}`, { waitUntil: "load" });
  await page.waitForSelector("#app", { timeout: 15000 });
  await page
    .waitForFunction(() => (document.querySelector("#app")?.textContent || "").length > 100, null, {
      timeout: 15000,
    })
    .catch(() => null);
  return page;
}

/** The toast on screen now (the dashboard has one #toast node; hidden = gone). */
export async function toasts(page) {
  return page
    .evaluate(() => {
      const n = document.getElementById("toast");
      return n && !n.hidden ? n.textContent || "" : "";
    })
    .catch(() => "");
}
/** Forget the current toast, so the next one seen is an answer to what comes next. */
export const clearToast = (page) =>
  page
    .evaluate(() => {
      const n = document.getElementById("toast");
      if (n) {
        n.textContent = "";
        n.hidden = true;
      }
    })
    .catch(() => {});
/** Wait for a toast matching `re`; answers its text or null. */
export const waitToast = (page, re, ms = 15000) =>
  maybe(
    async () => {
      const t = await toasts(page);
      return re.test(t) ? t : null;
    },
    `toast ${re}`,
    ms,
    200,
  );

let shotN = 0;
export async function shot(page, name) {
  shotN += 1;
  await page
    .screenshot({ path: `${OUT}/${String(shotN).padStart(3, "0")}-${name}.png`, fullPage: true })
    .catch(() => {});
}

// WCAG 2.1 A + AA audit (the same gate as regress.mjs): critical/serious fail,
// moderate/minor are notes, contrast axe could not measure is budgeted.
const CONTRAST_INCOMPLETE_BUDGET = 3;
export async function auditA11y(pg, label, r) {
  if (!AXE_SOURCE) return;
  if (!(await pg.evaluate(() => typeof globalThis.axe !== "undefined")))
    await pg.evaluate(AXE_SOURCE);
  const res = await pg
    .evaluate(async () => {
      const neutral = document.createElement("style");
      neutral.textContent = "*::before,*::after{content:none!important}";
      document.head.appendChild(neutral);
      try {
        // eslint-disable-next-line no-undef
        const out = await axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        const violations = out.violations.map((x) => {
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
        const inc = out.incomplete.find((x) => x.id === "color-contrast");
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
  serious.length
    ? r.bad(`a11y '${label}': ${fmt(serious)}`)
    : r.ok(
        `a11y '${label}': no critical/serious WCAG 2.1 A/AA violations${minor.length ? ` (${minor.length} moderate/minor)` : ""}`,
      );
  if (minor.length) r.note(`a11y '${label}' moderate/minor: ${fmt(minor)}`);
  if (res.incomplete.length > CONTRAST_INCOMPLETE_BUDGET)
    r.bad(
      `a11y '${label}': ${res.incomplete.length} text nodes' contrast could not be measured (budget ${CONTRAST_INCOMPLETE_BUDGET}): ${res.incomplete.slice(0, 6).join(", ")}`,
    );
}

/**
 * The layout probe of regress.mjs §7b, for one page at its current width: answers
 * the list of problems (empty = the view fits).
 */
export async function layoutProblems(pg, v) {
  const m = await pg.evaluate(() => {
    const vw = window.innerWidth;
    const inView = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const rr = n.getBoundingClientRect();
      if (!rr.width) return null;
      return rr.left >= -1 && rr.right <= vw + 1;
    };
    const wide = [...document.querySelectorAll('#app svg[viewBox="0 0 24 24"]')]
      .map((s) => s.getBoundingClientRect().width)
      .filter((x) => x > 48);
    const squashed = [...document.querySelectorAll("#app svg[width][height]")]
      .filter((s) => {
        const rr = s.getBoundingClientRect();
        const aw = +s.getAttribute("width");
        const ah = +s.getAttribute("height");
        if (!rr.height || !aw || !ah) return false;
        return rr.width / rr.height < (aw / ah) * 0.75;
      })
      .map(
        (s) =>
          `${s.getAttribute("class") || "svg"} ${s.getBoundingClientRect().width.toFixed(1)}px`,
      );
    const pipe = document.querySelector(".pipeline-panel .pipeline");
    return {
      sw: document.documentElement.scrollWidth,
      vw,
      search: inView(".cmdk-trigger"),
      newBtn: inView(".btn-new"),
      logout: inView(".logout-btn"),
      wide,
      squashed,
      pipeDisplay: pipe ? getComputedStyle(pipe).display : null,
    };
  });
  const w = m.vw;
  const out = [];
  const t = `${v}@${w}`;
  if (m.sw > m.vw) out.push(`${t} scrollWidth ${m.sw} > ${m.vw}`);
  for (const k of ["search", "newBtn", "logout"])
    if (m[k] === false) out.push(`${t} header ${k} outside the viewport`);
  if (m.wide.length) out.push(`${t} ${m.wide.length} icon(s) wider than 48px`);
  if (m.squashed.length)
    out.push(`${t} ${m.squashed.length} icon(s) squashed: ${m.squashed.slice(0, 3).join(", ")}`);
  if (m.pipeDisplay && m.pipeDisplay !== "flex")
    out.push(`${t} dev-flow strip is display:${m.pipeDisplay}`);
  return out;
}

export function appendJsonl(file, obj) {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}
