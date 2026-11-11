#!/usr/bin/env node
// =====================================================================
// A FEATURE SHIPS WHEN ALL ITS WORK HAS LANDED (external review 17, finding 3).
// ---------------------------------------------------------------------
// The feature-planning loop stamps the same `Feature-Id: <id>` line on every ticket of a
// feature epic; the merge used to advance the feature to shipped when ANY one of them
// landed (reproduced: ticket 1 done, ticket 2 and the acceptance ticket drafts, the
// feature went building -> shipped). Real Dispatch and Memory databases and CLIs, the
// production function (bin/merge-ticket.mjs applyDigestAndFeature, in a child process so
// its config comes from the environment like a real run):
//   F1  the first implementation ticket lands            -> still building
//   F2  every implementation ticket lands, not acceptance -> still building
//   F3  everything landed (the acceptance ticket last; it carries no marker)
//                                                          -> shipped, exactly once; a
//       re-run of any landing and `gaffer merge` on a done ticket do not ship it again
//   F4  a cancelled sibling is not waited for              -> shipped
//   F5  a prepared delta naming the feature (no id) obeys the same rule
//   F6  Dispatch unreadable on the landing                 -> not shipped (fail closed)
//   F7  memory unreachable on the completing landing       -> still building; the idle
//       re-evaluation (lib/tick-idle.sh -> merge-ticket.mjs --reconcile-features) ships it;
//       a feature whose every ticket was cancelled is never shipped by it
//   F8  a ticket that only quotes a marker (an ingested issue body) ships nothing: not a
//       backlog feature, not a building one whose epic is not filed yet, not an unknown id
//   F9  an epic naming two features: its landing is held with the reason, the idle pass
//       evaluates each by id
//   F10 the idle pass asks Dispatch once for every building feature (not once each)
// (The PR-mode landing paths are covered end to end in feature-ship-pr-landing.test.sh.)
// Run: node runner/test/feature-ship-gate.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const ROOT = resolve(RUNNER_DIR, "..");
const MERGE = resolve(RUNNER_DIR, "bin", "merge-ticket.mjs");
const DISPATCH_JS = resolve(ROOT, "packages", "dispatch", "dist", "cli", "index.js");
const MEMORY_JS = resolve(ROOT, "packages", "memory", "dist", "bin", "memory.js");

if (!existsSync(DISPATCH_JS) || !existsSync(MEMORY_JS)) {
  console.log("SKIP: build the workspace first (dispatch / memory CLI not built)");
  process.exit(77);
}

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const assert = (l, c) => (c ? ok(l) : fail(l));

const WORK = gafferMkdtemp(resolve(tmpdir(), "feature-ship-gate-"));
const BASE_ENV = {
  ...process.env,
  DISPATCH_AUDIT_OFF: "1",
  MEMORY_AUDIT_OFF: "1",
  CLAUDE_BIN: "/nonexistent/claude",
};
delete BASE_ENV.GAFFER_DIGEST_DISABLE;
delete BASE_ENV.GAFFER_PRINCIPAL_TOKEN;

/** One factory: its own Dispatch + Memory databases, a repo, a digest. */
function world(name) {
  const dir = resolve(WORK, name);
  mkdirSync(resolve(dir, "data"), { recursive: true });
  mkdirSync(resolve(dir, "repo"), { recursive: true });
  const w = {
    dir,
    env: {
      ...BASE_ENV,
      HOME: dir,
      GAFFER_DATA: resolve(dir, "data"),
      DISPATCH_DB: resolve(dir, "data", "dispatch.sqlite"),
      MEMORY_DB: resolve(dir, "data", "memory.sqlite"),
    },
  };
  w.wg = (...args) => {
    const r = spawnSync(process.execPath, [DISPATCH_JS, "--db", w.env.DISPATCH_DB, ...args], {
      encoding: "utf8",
      env: w.env,
    });
    if (r.status !== 0) throw new Error(`wg ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  w.lg = (...args) => {
    const r = spawnSync(process.execPath, [MEMORY_JS, ...args], { encoding: "utf8", env: w.env });
    if (r.status !== 0) throw new Error(`memory ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  spawnSync("git", ["init", "-q", "-b", "main", resolve(dir, "repo")], { encoding: "utf8" });
  w.wg("init");
  w.wg("repo", "add", "-n", "demo", "--path", resolve(dir, "repo"), "--branch", "main");
  w.lg(
    "digest",
    "set",
    "demo",
    "--source",
    "onboard",
    "--overview",
    "o",
    "--structure",
    "s",
    "--conventions",
    "c",
    "--stack",
    "k",
  );
  return w;
}

/** A building feature filed as an epic of `n` marked tickets plus its acceptance ticket. */
function featureEpic(w, { n = 2, name = "Refunds", acceptance = true } = {}) {
  const out = w.lg(
    "feature",
    "add",
    "demo",
    "--name",
    name,
    "--summary",
    "s",
    "--status",
    "building",
  );
  const id = /added feature (\S+)/.exec(out)[1];
  const plan = {
    epic: {
      name: `${name} epic`,
      description: "auto-planned",
      ...(acceptance ? {} : { acceptance: false }),
    },
    tickets: Array.from({ length: n }, (_, i) => ({
      title: `${name} part ${i + 1}`,
      description: `Part ${i + 1}.\n\nFeature-Id: ${id}`,
      acceptanceCriteria: ["works"],
      repo: "demo",
      dependsOn: [],
    })),
  };
  const planFile = resolve(w.dir, `plan-${name}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const res = JSON.parse(w.wg("epic", "create", planFile));
  return { id, tickets: res.ticket_numbers, acceptance: res.acceptance_ticket_number };
}

/** Test fixture: put tickets in a status directly (a real landing is the PR test's job). */
function setStatus(w, status, ...numbers) {
  const db = new DatabaseSync(w.env.DISPATCH_DB);
  try {
    for (const num of numbers)
      db.prepare("UPDATE tickets SET status = ? WHERE number = ?").run(status, num);
  } finally {
    db.close();
  }
}

function featureRow(w, id) {
  const db = new DatabaseSync(w.env.MEMORY_DB, { readOnly: true });
  try {
    const row = db.prepare("SELECT status FROM feature WHERE id = ?").get(id);
    const shipped = db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE lore_id = ? AND kind LIKE 'feature_%' AND json_extract(payload, '$.to') = 'shipped'",
      )
      .get(id).n;
    return { status: row?.status ?? "missing", shippedEvents: Number(shipped) };
  } finally {
    db.close();
  }
}

/** applyDigestAndFeature for ticket `n`, as a merge of it runs it. */
function landed(w, n, extraEnv = {}) {
  const driver = resolve(w.dir, `apply-${n}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    driver,
    `const { applyDigestAndFeature } = await import(${JSON.stringify(MERGE)});\n` +
      `process.stdout.write(JSON.stringify(applyDigestAndFeature({ ticketNumber: ${n}, repo: "demo" })));\n`,
  );
  const r = spawnSync(process.execPath, [driver], {
    encoding: "utf8",
    env: { ...w.env, ...extraEnv },
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { parseError: r.stdout, stderr: r.stderr };
  }
}

function mergeTicket(w, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [MERGE, ...args], {
    encoding: "utf8",
    env: { ...w.env, ...extraEnv },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    /* null */
  }
  return { status: r.status, out, stderr: r.stderr };
}

try {
  console.log("== F1-F3: an epic of two implementation tickets and its acceptance ticket ==");
  {
    const w = world("f1");
    const f = featureEpic(w);
    const [t1, t2] = f.tickets;
    const acc = f.acceptance;
    assert(
      "setup: the epic has two implementation tickets and an acceptance ticket",
      t1 && t2 && acc,
    );

    setStatus(w, "done", t1);
    const r1 = landed(w, t1);
    assert(
      "F1: the landing ran its digest step (digest-stamp ok)",
      r1.applied === true && r1.jobs?.some((j) => j.kind === "digest-stamp" && j.ok),
    );
    assert(
      `F1: first ticket landed -> feature still building (got ${featureRow(w, f.id).status})`,
      featureRow(w, f.id).status === "building",
    );
    assert(
      "F1: the decision names the tickets still to land",
      r1.feature?.decision === "held" && /#2|#3/.test(r1.feature?.reason ?? ""),
    );

    setStatus(w, "done", t2);
    landed(w, t2);
    assert(
      `F2: every implementation ticket landed, acceptance not -> still building (got ${featureRow(w, f.id).status})`,
      featureRow(w, f.id).status === "building",
    );

    setStatus(w, "done", acc);
    const r3 = landed(w, acc);
    const after = featureRow(w, f.id);
    assert(
      `F3: the acceptance ticket (no marker) lands last -> shipped (got ${after.status}, decision ${r3.feature?.decision})`,
      after.status === "shipped" && r3.feature?.decision === "shipped",
    );
    assert(`F3: exactly one ship recorded (got ${after.shippedEvents})`, after.shippedEvents === 1);
    const again = [landed(w, acc), landed(w, t1)];
    assert(
      "F3: re-running a landing never ships it twice (already_shipped)",
      featureRow(w, f.id).shippedEvents === 1 &&
        again.every((r) => r.feature?.decision === "already_shipped"),
    );
    const rerun = mergeTicket(w, ["--ticket", String(t1)]);
    assert(
      "F3: `gaffer merge` on a done ticket re-evaluates the feature, ships nothing twice",
      rerun.out?.phase === "already_merged" &&
        rerun.out?.feature?.decision === "already_shipped" &&
        featureRow(w, f.id).shippedEvents === 1,
    );
  }

  console.log("== F4: a cancelled sibling is listed, not waited for ==");
  {
    const w = world("f4");
    const f = featureEpic(w);
    const [t1, t2] = f.tickets;
    setStatus(w, "done", t1);
    setStatus(w, "cancelled", t2);
    landed(w, t1);
    assert(
      "F4: one done, one cancelled, acceptance open -> still building",
      featureRow(w, f.id).status === "building",
    );
    setStatus(w, "done", f.acceptance);
    const r = landed(w, f.acceptance);
    assert(
      `F4: the acceptance ticket lands -> shipped (cancelled #${t2} not counted) (got ${featureRow(w, f.id).status})`,
      featureRow(w, f.id).status === "shipped" && /cancelled/.test(r.feature?.reason ?? ""),
    );
  }

  console.log("== F5: a prepared delta that names the feature obeys the same rule ==");
  {
    const w = world("f5");
    const f = featureEpic(w, { name: "Exports" });
    // A ticket with no Feature-Id (not in the epic) whose delivery prepared a delta
    // naming the feature by name: the old merge added it as shipped (dedupe by name).
    const extra = JSON.parse(w.wg("ticket", "create", "-t", "Export docs", "-d", "docs"));
    const n = extra.ticket.number;
    w.wg(
      "attach-evidence",
      String(n),
      "--type",
      "manual_note",
      "--summary",
      `GAFFER_DIGEST_DELTA_V1 ${JSON.stringify({ sections: [], feature: { name: "Exports", summary: "x" } })}`,
    );
    setStatus(w, "done", n);
    const r = landed(w, n);
    assert(
      `F5: the delta's feature (epic not landed) stays building (got ${featureRow(w, f.id).status}, ${r.feature?.decision})`,
      featureRow(w, f.id).status === "building" && r.feature?.decision === "held",
    );
    setStatus(w, "done", ...f.tickets, f.acceptance);
    const r2 = landed(w, n);
    assert(
      `F5: with the epic landed too, the delta's landing ships it (got ${featureRow(w, f.id).status})`,
      featureRow(w, f.id).status === "shipped" && r2.feature?.decision === "shipped",
    );
    // A name the ledger does not know is a feature this ticket alone built.
    const lone = JSON.parse(w.wg("ticket", "create", "-t", "Lone", "-d", "lone"));
    w.wg(
      "attach-evidence",
      String(lone.ticket.number),
      "--type",
      "manual_note",
      "--summary",
      `GAFFER_DIGEST_DELTA_V1 ${JSON.stringify({ feature: { name: "Brand new", summary: "y" } })}`,
    );
    setStatus(w, "done", lone.ticket.number);
    const r3 = landed(w, lone.ticket.number);
    assert(
      "F5: an unknown feature name is recorded as shipped by the ticket that built it",
      r3.feature?.decision === "added_shipped" &&
        /\[shipped\] Brand new/.test(w.lg("features", "demo")),
    );
  }

  console.log("== F6: Dispatch unreadable on the landing -> nothing shipped ==");
  {
    const w = world("f6");
    const f = featureEpic(w, { n: 1, acceptance: false });
    setStatus(w, "done", f.tickets[0]);
    const stub = resolve(w.dir, "dispatch-down.mjs");
    writeFileSync(stub, "process.stderr.write('database is locked\\n'); process.exit(1);\n");
    const r = landed(w, f.tickets[0], { DISPATCH_CLI: stub });
    assert(
      `F6: Dispatch down -> still building (got ${featureRow(w, f.id).status})`,
      featureRow(w, f.id).status === "building" && r.feature?.decision !== "shipped",
    );
  }

  console.log("== F7: memory unreachable on the completing landing -> the idle pass ships it ==");
  {
    const w = world("f7");
    const f = featureEpic(w);
    setStatus(w, "done", ...f.tickets, f.acceptance);
    const stub = resolve(w.dir, "memory-down.mjs");
    writeFileSync(
      stub,
      "process.stderr.write('SQLITE_BUSY: database is locked\\n'); process.exit(1);\n",
    );
    const r = landed(w, f.acceptance, { MEMORY_CLI: stub });
    assert(
      `F7: the completing landing could not write memory -> still building (got ${featureRow(w, f.id).status}, ${r.feature?.decision})`,
      featureRow(w, f.id).status === "building",
    );
    // A second feature whose every ticket was cancelled: nothing landed, never shipped.
    const g = featureEpic(w, { name: "Abandoned", acceptance: false });
    setStatus(w, "cancelled", ...g.tickets);
    // A third, still in flight.
    const h = featureEpic(w, { name: "Inflight" });

    // The idle pass, as tick.sh runs it (lib/tick-idle.sh).
    const idle = spawnSync(
      "bash",
      [
        "-c",
        `log() { printf '%s\\n' "$*" >> "$GAFFER_DATA/factory.log"; }; ` +
          `jget() { node "${RUNNER_DIR}/lib/json-tool.mjs" expr "$1"; }; HERE="${RUNNER_DIR}"; DRY_RUN=0; ` +
          `source "${RUNNER_DIR}/lib/tick-idle.sh" && _gaffer_idle_feature_reconcile`,
      ],
      { encoding: "utf8", env: w.env },
    );
    assert(
      `F7: the idle re-evaluation ran (rc ${idle.status}: ${idle.stderr.trim().slice(0, 200)})`,
      idle.status === 0,
    );
    const after = featureRow(w, f.id);
    assert(
      `F7: the idle pass shipped the stranded feature exactly once (got ${after.status}, ${after.shippedEvents})`,
      after.status === "shipped" && after.shippedEvents === 1,
    );
    assert(
      "F7: a feature whose every ticket was cancelled is not shipped",
      featureRow(w, g.id).status === "building",
    );
    assert(
      "F7: a feature still in flight is not shipped",
      featureRow(w, h.id).status === "building",
    );
    const flog = existsSync(resolve(w.env.GAFFER_DATA, "factory.log"))
      ? require("node:fs").readFileSync(resolve(w.env.GAFFER_DATA, "factory.log"), "utf8")
      : "";
    assert(`F7: the idle pass logs what it shipped (${flog.trim()})`, flog.includes(f.id));
    const second = mergeTicket(w, ["--reconcile-features"]);
    assert(
      "F7: a second pass ships nothing more",
      second.status === 0 &&
        second.out?.shipped?.length === 0 &&
        featureRow(w, f.id).shippedEvents === 1,
    );
  }

  console.log("== F8: a ticket that only quotes a marker ships nothing (review of R3) ==");
  {
    const w = world("f8");
    const addFeature = (name, status) =>
      /added feature (\S+)/.exec(
        w.lg("feature", "add", "demo", "--name", name, "--summary", "s", "--status", status),
      )[1];
    const ticket = (title, desc) =>
      JSON.parse(w.wg("ticket", "create", "-t", title, "-d", desc)).ticket.number;
    // An ingested issue body quoting a backlog feature's marker in a code block.
    const backlog = addFeature("Never built", "backlog");
    const t1 = ticket("Issue #12", "Steps to reproduce:\n```\nFeature-Id: " + backlog + "\n```\n");
    setStatus(w, "done", t1);
    const r1 = landed(w, t1);
    assert(
      `F8: a backlog feature is never shipped by a ticket quoting its marker (got ${featureRow(w, backlog).status}, ${r1.feature?.decision})`,
      featureRow(w, backlog).status === "backlog" && r1.feature?.decision === "held",
    );
    // A feature claimed into building whose epic is not filed yet (still being planned).
    const planning = addFeature("In planning", "building");
    const t2 = ticket("Issue #13", "Feature-Id: " + planning);
    setStatus(w, "done", t2);
    const r2 = landed(w, t2);
    assert(
      `F8: a building feature with no epic yet is not shipped by a stray marked ticket (got ${featureRow(w, planning).status}, ${r2.feature?.decision})`,
      featureRow(w, planning).status === "building" && r2.feature?.decision === "held",
    );
    const rec = mergeTicket(w, ["--reconcile-features"]);
    assert(
      "F8: nor by the idle pass",
      rec.status === 0 && featureRow(w, planning).status === "building",
    );
    // An id the ledger does not hold: held and said so, not reported as a failed ship.
    const t3 = ticket("Typo", "Feature-Id: nosuchfeature");
    setStatus(w, "done", t3);
    const r3 = landed(w, t3);
    assert(
      `F8: an unknown feature id is held, not a failed ship (${r3.feature?.decision}: ${r3.feature?.reason})`,
      r3.feature?.decision === "held" && /no feature nosuchfeature/.test(r3.feature?.reason ?? ""),
    );
  }

  console.log("== F9: an epic naming two features ships neither on its landing, says why ==");
  {
    const w = world("f9");
    const ids = ["Alpha", "Beta"].map(
      (name) =>
        /added feature (\S+)/.exec(
          w.lg("feature", "add", "demo", "--name", name, "--summary", "s", "--status", "building"),
        )[1],
    );
    const planFile = resolve(w.dir, "plan-two.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        epic: { name: "Two features", description: "x" },
        tickets: ids.map((id, i) => ({
          title: `part ${i}`,
          description: `p\n\nFeature-Id: ${id}`,
          acceptanceCriteria: ["w"],
          repo: "demo",
          dependsOn: [],
        })),
      }),
    );
    const res = JSON.parse(w.wg("epic", "create", planFile));
    setStatus(w, "done", ...res.ticket_numbers, res.acceptance_ticket_number);
    const r = landed(w, res.acceptance_ticket_number);
    assert(
      `F9: the acceptance landing is held with the reason (${JSON.stringify(r.feature)})`,
      r.feature?.decision === "held" &&
        /more than one feature/.test(r.feature?.reason ?? "") &&
        ids.every((id) => featureRow(w, id).status === "building"),
    );
    const rec = mergeTicket(w, ["--reconcile-features"]);
    assert(
      "F9: the idle pass evaluates each by id and ships both",
      rec.status === 0 && ids.every((id) => featureRow(w, id).status === "shipped"),
    );
  }

  console.log("== F10: the idle pass asks Dispatch once for every building feature ==");
  {
    const w = world("f10");
    const fs = [featureEpic(w, { name: "One" }), featureEpic(w, { name: "Two" })];
    featureEpic(w, { name: "Three" });
    for (const f of fs) setStatus(w, "done", ...f.tickets, f.acceptance);
    const count = resolve(w.dir, "dispatch-calls.txt");
    const wrapper = resolve(w.dir, "dispatch-count.mjs");
    writeFileSync(
      wrapper,
      [
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        `appendFileSync(${JSON.stringify(count)}, process.argv.slice(2).join(" ") + "\\n");`,
        `const r = spawnSync(process.execPath, [${JSON.stringify(DISPATCH_JS)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
        "process.exit(r.status ?? 1);",
      ].join("\n"),
    );
    const rec = mergeTicket(w, ["--reconcile-features"], { DISPATCH_CLI: wrapper });
    const calls = existsSync(count)
      ? require("node:fs").readFileSync(count, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert(
      `F10: two complete features shipped, one held (${JSON.stringify(rec.out)})`,
      rec.status === 0 && rec.out?.shipped?.length === 2 && rec.out?.held === 1,
    );
    assert(
      `F10: one Dispatch process for three features (got ${calls.length}: ${calls.join(" | ")})`,
      calls.length === 1,
    );
  }
} finally {
  if (process.env.KEEP !== "1") rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
