#!/usr/bin/env node
/* global document, window */
// =====================================================================
// SCREENSHOTS: rebuild every dashboard image under docs/img from a demo world the
// real factory has worked through, then capture each view with Playwright.
//
//   pnpm -r build
//   node scripts/screenshots.mjs                  # ~20 minutes; writes docs/img/*.png
//   node scripts/screenshots.mjs --keep           # leave the dashboard up afterwards
//   node scripts/screenshots.mjs --reuse --only health,ticket-testing
//                                                 # recapture some shots from a kept world
//   node scripts/screenshots.mjs --from move      # pick a stopped run up at a phase
//                                                 # (world, history, open, move, hand, capture)
//
// The world is the browser harness's (scripts/ui-regression/setup.sh: a throwaway
// GAFFER_DATA, the stub worker standing in for the agent CLI, the dashboard through
// `gaffer dashboard --restart`), so no model is called and nothing is spent. On top of it:
//
//   1. three TaskFlow repos (scripts/screenshots-world.mjs) with real code and passing
//      tests, onboarded through POST /repos/onboard (digest, cards, code index);
//   2. five epics and loose tickets, every delivered one driven through the live path:
//      Poll for work → delivery (the stub commits the scripted change) → gates → the
//      tester first (black-box tests, clean replay, the cli acceptance transcript) →
//      a person's approval of the tested commit → Merge now (gates and the tester's
//      replay on the merge candidate) → done. Along the way: a rework attempt, a tester
//      FAIL, review comments and a Fix-these round, a paused, a blocked and a held
//      ticket, and an escaped-defect link from a later bug to the change it broke;
//   3. the history spread over the last few weeks: every timestamp the run wrote (the
//      databases, the usage ledger, the replay manifests) is moved onto a demo timeline
//      ending now, and the event log's hash chain is recomputed over the moved rows;
//   4. what a person adds by hand: approved lore, the Factory Map's scopes, the club and
//      squad names, open decisions, agents holding claims, and ledger rows for the call
//      kinds the run made too few of for the routing scorecard to compare;
//   5. the captures: 1440x900 at device scale 2, fonts loaded, animations stopped,
//      cropped to the content, palette PNGs through sharp when it resolves (installed
//      beside playwright-core in the harness's cache dir).
//
// Env: SCREENS_OUT (default /tmp/gaffer-screenshots) · SCREENS_PORT (default 8799)
//      PLAYWRIGHT_CHROMIUM (a chromium binary; default playwright-core's resolution)
// Never touches the checkout's own .gaffer/. The agent CLI is never run: setup.sh puts
// the stub first on PATH and CLAUDE_BIN at it, and model credentials are dropped from
// the environment before anything starts.
// =====================================================================
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DRAFT_LORE, EPICS, LOOSE, LORE, REPOS } from "./screenshots-world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const OUT = path.resolve(opt("--out", process.env.SCREENS_OUT || "/tmp/gaffer-screenshots"));
const PORT = Number(opt("--port", process.env.SCREENS_PORT || "8799"));
const IMG = path.resolve(opt("--img-dir", path.join(ROOT, "docs/img")));
const ONLY = (opt("--only", "") || "").split(",").filter(Boolean);
const REUSE = flag("--reuse"); // the same as --from capture
const KEEP = flag("--keep") || REUSE;
const BASE = `http://127.0.0.1:${PORT}`;
const PW_CACHE = process.env.UI_PW_CACHE || `${OUT}-pw`;

for (const k of [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete process.env[k];
process.env.npm_config_engine_strict = "false";

const t0 = Date.now();
const log = (m) => console.log(`[screens ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => {
  console.error(`screenshots: ${m}`);
  process.exit(1);
};

// ── the world ───────────────────────────────────────────────────────────────
const ENV_FILE = `${OUT}/world.env`;
function bash(script, extraEnv = {}) {
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) die(`bash failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function boot() {
  log(`building the world in ${OUT} (dashboard on :${PORT})`);
  // setup.sh builds the harness world; the models are then named by tier so the
  // usage ledger and the scorecard read cheap / mid / strong, and the dashboard is
  // restarted with that env. world.env keeps the env for the restart after the move.
  bash(
    `set -uo pipefail
     export UI_REGRESS_OUT="${OUT}" UI_REGRESS_PORT="${PORT}" UI_PW_CACHE="${PW_CACHE}"
     export PATH="${OUT}/bin:$PATH"
     source "${ROOT}/scripts/ui-regression/setup.sh" >/dev/null
     export GAFFER_IMPL_MODEL=mid GAFFER_PLAN_MODEL=strong GAFFER_CARD_MODEL=cheap
     export -p | grep -v -E ' (ANTHROPIC_[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN|BASH_[A-Z_]*|SHLVL|PWD|OLDPWD|_)=' > "${ENV_FILE}"
     bash "${ROOT}/runner/gaffer" dashboard --restart >/dev/null 2>&1`,
  );
  restartDashboard(false);
}

let TOKEN = "";
let GAFFER_DATA = "";
function restartDashboard(again = true) {
  const out = bash(
    `set -uo pipefail
     source "${ENV_FILE}"
     ${again ? `bash "${ROOT}/runner/gaffer" dashboard --restart >/dev/null 2>&1` : ""}
     for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
     printf 'TOKEN=%s\\nGAFFER_DATA=%s\\n' "$(cat "$GAFFER_DATA/dashboard-token")" "$GAFFER_DATA"`,
  );
  TOKEN = /TOKEN=(\S+)/.exec(out)?.[1] || die("no dashboard token");
  GAFFER_DATA = /GAFFER_DATA=(\S+)/.exec(out)[1];
}
const stopDashboard = () => {
  try {
    process.kill(Number(readFileSync(`${GAFFER_DATA}/dashboard.pid`, "utf8")));
  } catch {
    /* already gone */
  }
};

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
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
async function must(method, p, body) {
  const r = await api(method, p, body);
  if (r.status >= 300) die(`${method} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
}
async function waitFor(fn, label, ms = 120000, every = 1000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) die(`timed out waiting for ${label}`);
    await sleep(every);
  }
}
const idle = () =>
  waitFor(
    async () => ((await api("GET", "/api/runs")).json.active || []).length === 0,
    "the runs to finish",
    300000,
  );
const ticketOf = async (id) => (await api("GET", `/tickets/${id}`)).json.ticket;
/** `wg` against the world's database (the CLI the operator types). */
function wgArgs(...a) {
  const r = spawnSync(
    "node",
    [`${ROOT}/packages/dispatch/dist/cli/index.js`, "--db", `${GAFFER_DATA}/dispatch.sqlite`, ...a],
    { encoding: "utf8", env: { ...process.env, DISPATCH_DB: `${GAFFER_DATA}/dispatch.sqlite` } },
  );
  if (r.status !== 0) die(`wg ${a.join(" ")} → ${r.status} ${r.stderr}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout.trim();
  }
}
function lg(...a) {
  const r = spawnSync("node", [`${ROOT}/packages/memory/dist/bin/memory.js`, ...a], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DB: `${GAFFER_DATA}/memory.sqlite` },
  });
  if (r.status !== 0) die(`lg ${a.join(" ")} → ${r.status} ${r.stderr}`);
  return r.stdout.trim();
}
const stubModes = () => {
  try {
    return JSON.parse(readFileSync(`${GAFFER_DATA}/stub-mode.json`, "utf8"));
  } catch {
    return {};
  }
};
function setStub(number, spec) {
  const all = stubModes();
  all[String(number)] = spec;
  writeFileSync(`${GAFFER_DATA}/stub-mode.json`, JSON.stringify(all, null, 2));
}
const git = (cwd, ...a) =>
  execFileSync(
    "git",
    ["-c", "user.email=team@taskflow.example", "-c", "user.name=TaskFlow team", ...a],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  ).toString();

// ── the demo timeline ───────────────────────────────────────────────────────
// Every live step runs in seconds. Marks pin real instants to a demo clock: between
// two marks real time is stretched (STRETCH), and a mark can add a jump (a review that
// sat for hours, the days between tickets). At the end the last mark is pinned to its
// real time and everything the run wrote is moved onto that clock.
const STRETCH = 30;
const marks = [];
let fakeCursor = 0;
function mark(jumpMs = 0, stretch = STRETCH) {
  const now = Date.now();
  if (marks.length) fakeCursor += (now - marks[marks.length - 1].real) * stretch;
  fakeCursor += jumpMs;
  marks.push({ real: now, fake: fakeCursor });
}
const HOUR = 3600000;
const DAY = 24 * HOUR;
// A deterministic jitter so two runs land on the same timeline shape.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// ── 1. repos ────────────────────────────────────────────────────────────────
const repoIds = {};
async function makeRepos() {
  for (const [name, r] of Object.entries(REPOS)) {
    const dir = `${OUT}/repos/${name}`;
    for (const [rel, src] of Object.entries(r.files)) {
      mkdirSync(path.dirname(`${dir}/${rel}`), { recursive: true });
      writeFileSync(`${dir}/${rel}`, src);
    }
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `Initial import of ${name}`);
    log(`onboarding ${name}`);
    await must("POST", "/repos/onboard", { repo: dir });
    const repo = await waitFor(
      async () =>
        ((await api("GET", "/repositories")).json.repositories || []).find((x) => x.name === name),
      `${name} to register`,
    );
    await idle();
    await must("POST", `/repos/${repo.id}/commands`, {
      test_command: "npm test",
      lint_command: "npm run lint",
    });
    repoIds[name] = repo.id;
  }
}

// ── 2. tickets ──────────────────────────────────────────────────────────────
const byKey = {}; // key → { spec, id, number }
/**
 * A delivered ticket's criteria each carry a check command the runner runs (the test
 * file its change adds), so the board and Review show machine evidence for them.
 */
function criteria(t) {
  const testFile = Object.keys(t.steps?.[0]?.files || {}).find((f) => /^test\//.test(f));
  return t.acs.map((a) =>
    typeof a !== "string"
      ? a
      : testFile
        ? { text: a, check_command: `node --test ${testFile}` }
        : { text: a },
  );
}
async function makeTickets() {
  for (const e of EPICS) {
    const plain = e.tickets.map((t) =>
      criteria(t)
        .filter((a) => !a.check_command)
        .map((a) => a.text),
    );
    const made = await must("POST", "/epics", {
      epic: { name: e.name, description: e.description, acceptance: false },
      tickets: e.tickets.map((t, i) => ({
        title: t.title,
        description: t.description,
        acceptanceCriteria: plain[i],
        risk_level: t.risk,
        repo: t.repo,
        access: "write",
        testable: true,
        ...(t.dependsOn
          ? { dependsOn: t.dependsOn.map((k) => e.tickets.findIndex((x) => x.key === k)) }
          : {}),
      })),
    });
    const nums = made.ticket_numbers || [];
    for (const [i, t] of e.tickets.entries()) {
      const row = (await api("GET", `/tickets/${nums[i]}`)).json.ticket;
      if (!row?.id) die(`epic ${e.name}: no ticket #${nums[i]} for ${t.key}`);
      byKey[t.key] = { spec: t, id: row.id, number: row.number };
    }
  }
  for (const t of LOOSE) {
    const made = await must("POST", "/tickets", {
      title: t.title,
      description: t.description,
      risk_level: t.risk,
      repoIds: [{ repo_id: repoIds[t.repo], access: "write" }],
    });
    const row = made.ticket || made;
    for (const a of criteria(t).filter((x) => !x.check_command))
      await must("POST", `/tickets/${row.id}/acceptance-criteria`, a);
    await must("POST", `/tickets/${row.id}/testable`, { can_be_tested: true });
    byKey[t.key] = { spec: t, id: row.id, number: row.number };
  }
  for (const k of Object.keys(byKey)) {
    const { spec, id } = byKey[k];
    for (const a of criteria(spec).filter((x) => x.check_command))
      await must("POST", `/tickets/${id}/acceptance-criteria`, a);
    if (spec.contract) await must("POST", `/tickets/${id}/test-contract`, spec.contract);
    if (spec.profile) await must("POST", `/tickets/${id}/acceptance-profile`, spec.profile);
  }
  log(`created ${Object.keys(byKey).length} tickets in ${EPICS.length} epics`);
}

// ── 3. the live path ────────────────────────────────────────────────────────
async function poll() {
  const r = await api("POST", "/poll-work");
  if (r.status >= 300) die(`poll-work → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  await sleep(500);
  await idle();
}
async function pollUntil(k, want, tries = 6) {
  const { id, number } = byKey[k];
  for (let i = 0; i < tries; i++) {
    await poll();
    const st = (await ticketOf(id)).status;
    if (want.includes(st)) return st;
  }
  die(`#${number} (${k}) never reached ${want.join("|")}: it is ${(await ticketOf(id)).status}`);
}
async function ready(k) {
  await must("POST", `/tickets/${byKey[k].id}/ready`);
}
async function headCommits(k) {
  const d = (await api("GET", `/tickets/${byKey[k].id}/diff`)).json;
  return (d.repos || []).map((r) => ({ repo: r.repoId, sha: r.headSha }));
}
async function approve(k) {
  await api("GET", `/tickets/${byKey[k].id}/diff?include=impact`);
  await must("POST", `/tickets/${byKey[k].id}/review/approve`, { commits: await headCommits(k) });
}
async function land(k) {
  await must("POST", `/tickets/${byKey[k].id}/merge`);
  await waitFor(
    async () => (await ticketOf(byKey[k].id)).status === "done",
    `#${byKey[k].number} to land`,
    180000,
  );
  await idle();
}
const stubFor = (spec, mode = "tester_pass", extra = {}) => ({
  mode,
  ...(spec.steps ? { steps: spec.steps } : {}),
  ...(spec.tester ? { tester: spec.tester } : {}),
  ...extra,
});

async function drive(k) {
  const { spec, number } = byKey[k];
  const flow = spec.flow;
  log(`#${number} ${spec.title} → ${flow}`);
  if (flow === "done" || flow === "done_rework" || flow === "regression") {
    setStub(number, stubFor(spec));
    await ready(k);
    await pollUntil(k, ["in_review"]);
  } else if (flow === "done_tester_fail") {
    setStub(
      number,
      stubFor(spec, "tester_fail", {
        observation:
          "GET /tasks?overdue=1 still lists a task that is done but past its date; the first criterion says open tasks only.",
      }),
    );
    await ready(k);
    await pollUntil(k, ["refining"]);
    mark(2 * HOUR + rand() * 3 * HOUR);
    setStub(number, stubFor(spec));
    await ready(k);
    await pollUntil(k, ["in_review"]);
  } else if (flow === "review" || flow === "ready_for_merge") {
    setStub(number, stubFor(spec));
    await ready(k);
    await pollUntil(k, ["in_review"]);
    if (flow === "ready_for_merge") {
      mark(HOUR * (0.5 + rand()));
      await approve(k);
    }
    return;
  } else if (flow === "review_fix") {
    setStub(number, stubFor(spec));
    await ready(k);
    await pollUntil(k, ["in_review"]);
    mark(HOUR * 1.5);
    await reviewComments(k);
    mark(HOUR * 0.4);
    await must("POST", `/tickets/${byKey[k].id}/review/fix`, { to: "ready" });
    await pollUntil(k, ["in_review"]);
    return;
  } else if (flow === "testing") {
    setStub(number, stubFor(spec, "tester_no_verdict"));
    await ready(k);
    await pollUntil(k, ["in_testing"]);
    await poll();
    return;
  } else if (flow === "refining") {
    setStub(
      number,
      stubFor(spec, "tester_fail", {
        observation:
          "Pressing u on a card that is still open reopens nothing but reports success; u should do nothing there.",
      }),
    );
    await ready(k);
    await pollUntil(k, ["refining"]);
    return;
  } else if (flow === "blocked") {
    setStub(number, stubFor(spec, "fail_always"));
    await ready(k);
    await pollUntil(k, ["blocked"]);
    return;
  } else if (flow === "paused") {
    setStub(number, stubFor(spec, "pause_first"));
    await ready(k);
    await pollUntil(k, ["paused"]);
    return;
  } else return;
  // done flows: the person reads it after a while, approves the tested commit, lands it.
  mark(HOUR * (0.5 + rand() * 5));
  await approve(k);
  mark(HOUR * (0.1 + rand() * 0.5));
  await land(k);
  if (flow === "regression") {
    const of = byKey[spec.regressionOf].number;
    await must("POST", `/tickets/${byKey[k].id}/regression-of`, {
      of: String(of),
      note: `The digest subject change in #${of} let titles with a newline through to the email.`,
    });
  }
}

/** The person's review of the hero: a must-fix line comment and a consider. */
async function reviewComments(k) {
  const { spec, id } = byKey[k];
  const [head] = await headCommits(k);
  const repoDir = `${OUT}/repos/${spec.repo}`;
  for (const c of spec.comments) {
    const src = git(repoDir, "show", `${head.sha}:${c.path}`).split("\n");
    const line = src.findIndex((l) => l.includes(c.match)) + 1;
    if (!line) die(`comment anchor '${c.match}' not in ${c.path}`);
    await must("POST", `/tickets/${id}/review/comments`, {
      body: c.body,
      severity: c.severity,
      path: c.path,
      line,
      commit: head.sha,
    });
  }
}

const ALL = () => [...EPICS.flatMap((e) => e.tickets), ...LOOSE];
async function liveHistory() {
  const done = ALL().filter((t) =>
    ["done", "done_rework", "done_tester_fail", "regression"].includes(t.flow),
  );
  // The escaped change lands before the bug that is linked to it.
  done.sort((a, b) => (a.flow === "regression") - (b.flow === "regression"));
  const recent = 3; // the last few done tickets land today
  if (!marks.length) mark();
  for (const [i, t] of done.entries()) {
    if ((await ticketOf(byKey[t.key].id)).status === "done") continue;
    const today = i >= done.length - recent;
    mark(today ? HOUR * (0.4 + rand() * 0.4) : DAY * (0.5 + rand() * 0.7));
    await drive(t.key);
    mark();
  }
}
async function liveOpen() {
  const order = [
    "review",
    "review_fix",
    "ready_for_merge",
    "refining",
    "blocked",
    "paused",
    "testing",
  ];
  for (const f of order)
    for (const t of ALL().filter((x) => x.flow === f)) {
      if ((await ticketOf(byKey[t.key].id)).status !== "draft") continue;
      mark(HOUR * (0.3 + rand() * 0.5));
      await drive(t.key);
      mark();
    }
}

// ── 3b. move the run onto the demo timeline ─────────────────────────────────
const ISO = /\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/g;
function shiftFn() {
  const last = marks[marks.length - 1];
  const abs = marks.map((m) => ({ real: m.real, fake: last.real + (m.fake - last.fake) }));
  return (ms) => {
    if (ms >= last.real) return ms;
    if (ms <= abs[0].real) return abs[0].fake - (abs[0].real - ms);
    let i = 1;
    while (abs[i].real < ms) i++;
    const a = abs[i - 1];
    const b = abs[i];
    return a.fake + ((ms - a.real) / (b.real - a.real || 1)) * (b.fake - a.fake);
  };
}
function moveText(text, f) {
  return text.replace(ISO, (s) => {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return s;
    const out = new Date(Math.round(f(ms))).toISOString();
    return s.includes(".") ? out : out.replace(/\.\d+Z$/, "Z");
  });
}
async function moveTimeline() {
  log("moving the run onto the demo timeline");
  stopDashboard();
  await sleep(1500);
  const f = shiftFn();
  const { DatabaseSync } = await import("node:sqlite");
  const chain = await import(
    pathToFileURL(`${ROOT}/packages/dispatch/dist/events/eventChain.js`).href
  );
  for (const file of [`${GAFFER_DATA}/dispatch.sqlite`, `${GAFFER_DATA}/memory.sqlite`]) {
    const db = new DatabaseSync(file);
    db.exec("BEGIN");
    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .filter((t) => !/^CREATE VIRTUAL/i.test(t.sql || ""));
    for (const { name } of tables) {
      const info = db.prepare(`PRAGMA table_info("${name}")`).all();
      const cols = info.filter((c) => !c.type || /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name);
      if (!cols.length) continue;
      // A WITHOUT ROWID table is addressed by its primary key.
      let key = ["rowid"];
      try {
        db.prepare(`SELECT rowid FROM "${name}" LIMIT 1`).all();
      } catch {
        key = info
          .filter((c) => c.pk)
          .sort((x, y) => x.pk - y.pk)
          .map((c) => c.name);
      }
      if (!key.length) continue;
      const sel = [...key.map((k, i) => `"${k}" AS _k${i}`), ...cols.map((c) => `"${c}"`)].join(
        ",",
      );
      const where = key.map((k) => `"${k}" = ?`).join(" AND ");
      for (const row of db.prepare(`SELECT ${sel} FROM "${name}"`).all()) {
        const set = {};
        for (const c of cols) {
          const v = row[c];
          if (typeof v !== "string") continue;
          const nv = moveText(v, f);
          if (nv !== v) set[c] = nv;
        }
        const keys = Object.keys(set);
        if (keys.length)
          db.prepare(
            `UPDATE "${name}" SET ${keys.map((c) => `"${c}" = ?`).join(",")} WHERE ${where}`,
          ).run(...keys.map((c) => set[c]), ...key.map((_, i) => row[`_k${i}`]));
      }
    }
    if (file.endsWith("dispatch.sqlite")) {
      let prev = chain.EVENT_CHAIN_GENESIS;
      const upd = db.prepare("UPDATE work_events SET prev_hash = ?, hash = ? WHERE rowid = ?");
      for (const row of db
        .prepare("SELECT rowid AS seq, * FROM work_events ORDER BY rowid")
        .all()) {
        const hash = chain.eventHash(prev, row);
        upd.run(prev, hash, row.seq);
        prev = hash;
      }
    }
    db.exec("COMMIT");
    db.close();
  }
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === "worktrees"
          ? []
          : walk(`${dir}/${e.name}`)
        : [`${dir}/${e.name}`],
    );
  for (const file of walk(GAFFER_DATA)) {
    if (!/\.(jsonl|json|log)$/.test(file) || /stub-|settings\.json$/.test(file)) continue;
    if (statSync(file).size > 32 * 1024 * 1024) continue;
    const txt = readFileSync(file, "utf8");
    const moved = moveText(txt, f);
    if (moved !== txt) writeFileSync(file, moved);
  }
  restartDashboard(true);
}

// ── 4. what a person adds by hand ───────────────────────────────────────────
async function handWork() {
  log("lore, the map, the club, the squad, decisions and claims");
  // The harness seeds one draft for its own sample repo; this world never onboards it.
  for (const d of (await api("GET", "/api/memory/lore?status=draft")).json.lore || [])
    if (!REPOS[d.repo])
      await api("POST", `/api/memory/lore/${d.id}/reject`, {
        reason: "Not one of this factory's repos.",
      });
  for (const l of [...LORE, ...DRAFT_LORE])
    lg(
      "suggest",
      "--title",
      l.title,
      "--summary",
      l.summary,
      "--body",
      l.body,
      "--repo",
      l.repo,
      "--kind",
      l.kind,
    );
  const drafts = (await api("GET", "/api/memory/lore?status=draft")).json.lore || [];
  for (const l of LORE) {
    const d = drafts.find((x) => x.title === l.title);
    if (d) await must("POST", `/api/memory/lore/${d.id}/approve`, {});
  }

  // A digest a person wrote over the onboarding scan, and the feature ledger.
  for (const [name, r] of Object.entries(REPOS)) {
    const d = r.digest;
    lg(
      "digest",
      "set",
      name,
      "--overview",
      d.overview,
      "--structure",
      d.structure,
      "--conventions",
      d.conventions,
      "--stack",
      d.stack,
      "--source",
      "manual",
    );
    for (const [n, summary, status] of r.features)
      lg("feature", "add", name, "--name", n, "--summary", summary, "--status", status);
  }
  // Onboarding's intake questions, answered.
  for (const dcs of (await api("GET", "/decisions?status=open")).json.decisions || [])
    if (/^Onboarding intake/.test(dcs.title))
      await api("POST", `/decisions/${dcs.id}/resolve`, {
        status: "accepted",
        answer:
          "TaskFlow is a task list for small teams. Never mutate a list in place, keep the clock a parameter, and keep the API's handlers free of I/O. Out of scope: calendars beyond the ICS feed, and attachments.",
      });

  // The Factory Map: product areas, the services under them, and the repos they map to.
  const node = (n, type, d, risk) =>
    wgArgs("scope", "node", "create", "-n", n, "-t", type, "-d", d, "--risk", risk)?.node?.id;
  const product = node(
    "TaskFlow",
    "product",
    "Task lists for small teams: web, API and the daily digest",
    "medium",
  );
  const core = node(
    "Task domain",
    "domain",
    "Tasks, due dates, labels, recurrence and the digest",
    "medium",
  );
  const apiN = node(
    "Public API",
    "service",
    "HTTP API: task routes, sessions, rate limits",
    "high",
  );
  const web = node("Web board", "product", "The browser board people work in", "low");
  const notify = node("Notifications", "service", "Morning digest and reminders", "medium");
  for (const [a, b] of [
    [product, core],
    [product, apiN],
    [product, web],
    [core, notify],
    [apiN, core],
    [web, apiN],
  ])
    if (a && b) wgArgs("scope", "edge", "add", a, b);
  for (const [n, r] of [
    [core, "taskflow-core"],
    [notify, "taskflow-core"],
    [apiN, "taskflow-api"],
    [web, "taskflow-web"],
  ])
    if (n) wgArgs("scope", "repo", "link", n, r);

  await must("PATCH", "/api/club", {
    name: "TaskFlow FC",
    short_name: "TFC",
    kit_primary: "#1f4e79",
    kit_secondary: "#f2c14e",
  });

  // The squad: the runner's own agents get names, and three more agents hold claims.
  const squadNames = [
    ["Kev", 9],
    ["Rosie", 4],
    ["Dot", 7],
    ["Marcus", 10],
    ["Ines", 8],
    ["Tomasz", 6],
  ];
  const agents = () => wgArgs("agent", "list").agents || [];
  for (const nm of ["Delivery 2", "Delivery 3", "Delivery 4"])
    wgArgs("agent", "register", "-n", nm, "--as", "system");
  const list = agents();
  list.forEach((a, i) => {
    const [n, num] = squadNames[i % squadNames.length];
    wgArgs("agent", "rename", a.agent_id, "--name", n, "--number", String(num));
  });
  const claimers = list.filter((a) => /Delivery [234]/.test(a.registered_name || ""));
  const toClaim = Object.keys(byKey).filter((k) => byKey[k].spec.flow === "claimed");
  for (const [i, k] of toClaim.entries()) {
    await ready(k);
    const ag = claimers[i % Math.max(1, claimers.length)] || list[0];
    wgArgs("claim", "--agent", ag.agent_id, "--ttl", "86400");
  }

  for (const k of Object.keys(byKey)) {
    const { spec, id } = byKey[k];
    if (spec.flow === "ready") await ready(k);
    if (spec.flow === "cancelled")
      await must("POST", `/tickets/${id}/wont-do`, { reason: spec.reason });
  }
  await must("POST", "/decisions", {
    title: "Recurring tasks: generate on close or on a schedule?",
    question:
      "Should the next occurrence of a recurring task be created when the current one is closed, or by a nightly job from the rule? Closing is simpler; the job keeps occurrences on the calendar even when nobody closes the last one.",
    severity: "human_required",
    ticket_id: byKey["next-occurrence"].id,
  });
  await must("POST", "/decisions", {
    title: "Rate limit: per token or per user?",
    question:
      "A user with three API tokens gets 300 requests a minute under a per-token limit. Is that what we want?",
    severity: "human_preferred",
    ticket_id: byKey["rate-limit"].id,
  });
}

/** Pad any non-implement scorecard cell the run made too few calls in (onboarding, plan). */
async function padLedger() {
  const health = (await api("GET", "/api/health")).json;
  const cells = health.routing_scorecard?.cells || [];
  const ledger = `${GAFFER_DATA}/usage-ledger.jsonl`;
  const rows = readFileSync(ledger, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const add = [];
  for (const c of cells) {
    if (!c.too_few) continue;
    if (c.role === "implement") {
      log(`note: implement cell ${c.model}/${c.risk} has n=${c.n}`);
      continue;
    }
    const like = rows.find(
      (r) => (r.model_requested ?? "default") === c.model && (r.risk ?? "unknown") === c.risk,
    );
    if (!like) continue;
    for (let i = c.n; i < 12; i++) {
      const ts = new Date(Date.now() - (2 + rand() * 24) * DAY).toISOString();
      add.push({
        ...like,
        ts,
        started_at: ts,
        total_cost_usd: +(
          like.total_cost_usd > 0.05 ? like.total_cost_usd : 0.04 + rand() * 0.3
        ).toFixed(3),
      });
    }
  }
  if (add.length) {
    const merged = [...rows, ...add].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    writeFileSync(ledger, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
    log(`added ${add.length} ledger rows to small cells`);
  }
}

// ── 5. captures ─────────────────────────────────────────────────────────────
const SHOTS = []; // { name, file, bytes, view }
async function capture() {
  const req = createRequire(path.join(process.env.PW_CORE_ROOT || PW_CACHE, "package.json"));
  const { chromium } = req("playwright-core");
  let sharp = null;
  for (const from of [path.join(ROOT, "package.json"), path.join(PW_CACHE, "package.json")])
    try {
      sharp = createRequire(from)("sharp");
      break;
    } catch {
      /* next */
    }
  if (!sharp) {
    // Beside playwright-core in the harness's cache dir, as pw-install.sh installs that.
    spawnSync("npm", ["install", "--silent", "--no-save", "sharp@0.34.5"], {
      cwd: PW_CACHE,
      stdio: "ignore",
    });
    try {
      sharp = createRequire(path.join(PW_CACHE, "package.json"))("sharp");
    } catch {
      log("sharp does not resolve: the PNGs are written as captured (larger files)");
    }
  }
  const launch = process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {};
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?token=${TOKEN}#/overview`, { waitUntil: "load" });
  const STILL = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}`;
  const go = async (route, ready) => {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: "load" });
    await page.addStyleTag({ content: STILL });
    await page
      .waitForFunction(
        () => (document.querySelector("#app")?.textContent || "").trim().length > 200,
        null,
        { timeout: 20000 },
      )
      .catch(() => null);
    if (ready)
      await page
        .waitForSelector(ready, { timeout: 20000 })
        .catch(() => log(`note: ${route} has no ${ready}`));
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
    await page.evaluate(() => document.fonts.ready);
    await sleep(900);
  };
  const save = async (name, view, buf) => {
    const file = path.join(IMG, `${name}.png`);
    let out = buf;
    if (sharp)
      out = await sharp(buf)
        .png({ palette: true, quality: 92, effort: 10, compressionLevel: 9 })
        .toBuffer();
    writeFileSync(file, out);
    SHOTS.push({ name, view, bytes: out.length });
    log(`${name}.png ${(out.length / 1024).toFixed(0)} KB (${view})`);
  };
  const want = (n) => !ONLY.length || ONLY.includes(n);
  /** The page from the top, cut where its content ends (at most maxH CSS px). */
  const pageShot = async (name, view, maxH = 1700) => {
    if (!want(name)) return;
    const h = await page.evaluate(() => {
      const app = document.querySelector("#app");
      const r = app ? app.getBoundingClientRect() : { bottom: document.body.scrollHeight };
      return Math.ceil(r.bottom + window.scrollY);
    });
    await save(
      name,
      view,
      await page.screenshot({
        fullPage: true,
        clip: { x: 0, y: 0, width: 1440, height: Math.min(Math.max(h, 900), maxH) },
      }),
    );
  };
  /** One element, with a margin of page around it. */
  /** One element (or the box around several), with a margin of page around it. */
  const elShot = async (name, view, sels, pad = 16, maxH = 1600) => {
    if (!want(name)) return;
    const scrollY = await page.evaluate(() => window.scrollY);
    const boxes = [];
    for (const sel of [].concat(sels)) {
      const b = await page
        .locator(sel)
        .first()
        .boundingBox()
        .catch(() => null);
      if (b) boxes.push(b);
    }
    if (!boxes.length) return log(`note: no ${[].concat(sels).join(" / ")} for ${name}`);
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const x1 = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
    const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) + scrollY - pad);
    const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + scrollY + pad;
    await save(
      name,
      view,
      await page.screenshot({
        fullPage: true,
        clip: { x: x0, y: y0, width: x1 - x0, height: Math.min(y1 - y0, maxH) },
      }),
    );
  };
  const hero = byKey["finish-skips-done"].id;

  await go("overview", ".tactics .pitch");
  await pageShot("match-day-overview", "Overview", 1250);
  await elShot("match-day-tactics-board", "Overview: Tactics board", [".tactics .pitch"], 12);
  await go("floor", "svg");
  await pageShot("match-day-floor", "Floor", 1500);
  await go("work", ".card");
  await pageShot("board", "Work board", 1500);
  await go(`review/${hero}`, ".diff-line");
  await pageShot("match-day-review", "Review: the sign-off", 2200);
  await elShot("review-packet", "Review: the packet", [".rv-verdict", ".rv-impact"], 16, 1400);
  await elShot("review-backing", "Review: what backs this", ".rv-backing", 16, 1000);
  await go(`review/${byKey["rate-limit"].id}`, ".diff-line");
  await pageShot("review", "Review: a second sign-off", 1500);
  await go(`ticket/${hero}`, ".tk-testing");
  // Open the newest runtime-acceptance transcript, as a reader would.
  await page
    .locator(".tk-testing details > summary")
    .first()
    .click()
    .catch(() => null);
  await sleep(400);
  await pageShot("ticket", "Ticket page", 2000);
  await elShot("ticket-testing", "Ticket page: Independent testing", ".tk-testing", 16, 1600);
  await go("epics");
  await pageShot("epics", "Epics", 1500);
  await go("factory", "svg");
  await pageShot("factory-map", "Map", 1500);
  await go("memory");
  await page
    .locator("button", { hasText: /^\s*taskflow-core\s*$/ })
    .first()
    .click()
    .catch(() => null);
  await sleep(1200);
  await pageShot("memory", "Memory", 1600);
  await go("health", ".routing-panel");
  await pageShot("health", "Health", 2400);
  await elShot("health-measures", "Health: the four measures", ".measures-panel", 16);
  await elShot("health-routing", "Health: routing scorecard", ".routing-panel", 16);
  await go("settings");
  await pageShot("settings", "Settings", 1500);
  if (want("plan-build")) await planBuild(page, go, save);
  await browser.close();
}

/** Plan a build with the stub planner: a brief, its questions, an answer, the draw. */
async function planBuild(page, go, save) {
  await go("epics");
  const open = page.locator("button", { hasText: /Plan a build/ }).first();
  if (!(await open.count())) return log("note: no Plan a build button on Epics");
  await open.click();
  const box = page.locator(".sheet textarea, textarea").first();
  await box.fill(
    "A small task list for one person: add tasks, tick them off, and see what is still open.",
  );
  await page.keyboard.press("Enter");
  await page
    .waitForFunction(() => /planner asks/i.test(document.body.textContent || ""), null, {
      timeout: 60000,
    })
    .catch(() => null);
  await box.fill(
    "Completed tasks are archived, never deleted. Sort open tasks by due date, undated last.",
  );
  await page.keyboard.press("Enter");
  await page
    .waitForFunction(
      () =>
        /the draw|proposed|tickets/i.test(
          document.querySelector(".sheet, [role=dialog]")?.textContent || "",
        ),
      null,
      { timeout: 60000 },
    )
    .catch(() => null);
  await sleep(1500);
  await page.addStyleTag({
    content: "*{animation-duration:0s!important;transition:none!important}",
  });
  // The sheet scrolls to the newest turn; read it from the brief down.
  await page.evaluate(() => {
    for (const n of document.querySelectorAll("*"))
      if (n.scrollTop > 0 && n !== document.scrollingElement) n.scrollTop = 0;
  });
  await sleep(300);
  await save("plan-build", "Plan a build", await page.screenshot());
}

// ── main ────────────────────────────────────────────────────────────────────
if (!existsSync(`${ROOT}/packages/dispatch/dist/cli/index.js`)) die("build first: pnpm -r build");
mkdirSync(IMG, { recursive: true });
// Phases, in order; state.json after each one lets `--from <phase>` pick a run up again
// against the world it left (the dashboard is restarted from world.env).
const PHASES = ["world", "history", "open", "move", "hand", "capture"];
const FROM = REUSE ? "capture" : opt("--from", "world");
if (!PHASES.includes(FROM)) die(`--from takes one of ${PHASES.join(", ")}`);
const run = (p) => PHASES.indexOf(p) >= PHASES.indexOf(FROM);
const STATE = `${OUT}/state.json`;
function saveState(phase) {
  const ids = Object.fromEntries(
    Object.entries(byKey).map(([k, v]) => [k, { id: v.id, number: v.number }]),
  );
  writeFileSync(
    STATE,
    JSON.stringify({ phase, marks, fakeCursor, seed, repoIds, byKey: ids }, null, 2),
  );
}
if (FROM !== "world") {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  marks.push(...st.marks);
  fakeCursor = st.fakeCursor;
  seed = st.seed;
  Object.assign(repoIds, st.repoIds);
  const specs = [...EPICS.flatMap((e) => e.tickets), ...LOOSE];
  for (const [k, v] of Object.entries(st.byKey))
    byKey[k] = { ...v, spec: specs.find((t) => t.key === k) };
  restartDashboard(true);
}
if (run("world")) {
  boot();
  // A demo run makes far more ticks in an hour than a day's cap allows, and spends
  // more than a day's budget; both go back to their usual values after the run.
  await must("POST", "/api/settings", {
    settings: { GAFFER_DAILY_BUDGET_USD: "500", MAX_TICKS_PER_DAY: "1000" },
  });
  await makeRepos();
  await makeTickets();
  saveState("world");
}
if (run("history")) {
  await liveHistory();
  saveState("history");
}
if (run("open")) {
  await liveOpen();
  saveState("open");
}
if (run("move")) {
  await must("POST", "/api/settings", {
    settings: { GAFFER_DAILY_BUDGET_USD: "25", MAX_TICKS_PER_DAY: "50" },
  });
  await moveTimeline();
  saveState("move");
}
if (run("hand")) {
  await handWork();
  await padLedger();
  saveState("hand");
}
process.env.PW_CORE_ROOT ||= PW_CACHE;
await capture();
writeFileSync(`${OUT}/shots.json`, JSON.stringify(SHOTS, null, 2));
if (!KEEP) stopDashboard();
else log(`dashboard left running: ${BASE}/?token=${TOKEN}`);
log(`done: ${SHOTS.length} images in ${IMG}`);
