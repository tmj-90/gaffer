#!/usr/bin/env node
// =====================================================================
// Provenance trailers on a landed delivery's merge commit
// (lib/provenance-trailers.mjs; lib/land.sh _gaffer_merge_gate / _gaffer_land_gated;
// lib/automerge.sh gaffer_pr_merge; bin/merge-ticket.mjs gateProposedMerge /
// landGatedMerge / buildPrMergeArgv).
// ---------------------------------------------------------------------
// Proves, against a REAL dispatch schema (`dispatch init`) and real git repos:
//   T1 the trailer block: ticket, the approving actor (human or agent), the gate
//      verdicts (DoD per gate — a FAIL anywhere wins — the AC count, the tester's own
//      verdict transition since the latest approval, never an agent-recorded row);
//      "none recorded" when nothing approved it; no model name anywhere
//   T2 GAFFER_PROVENANCE_TRAILERS=0 (or off/false/no) → no trailers; unknown ticket → none
//   T3 a newline smuggled into an actor id cannot add a trailer line
//   T4 the merge gate's gated merge commit (the commit that lands) on the dashboard /
//      `gaffer merge` path (gateProposedMerge → landGatedMerge) carries the trailers as
//      a --no-ff merge commit git parses; without them it fast-forwards as before
//   T5 _gaffer_merge_gate → _gaffer_land_gated (the merge lane / AFK path) does the same
//   T6 the PR path puts them in `gh pr merge --body` (not for a rebase)
// Run: node runner/test/provenance-trailers.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..");
const ROOT = resolve(RUNNER, "..");
const CLI = resolve(ROOT, "packages/dispatch/dist/cli/index.js");

let pass = 0;
const fails = [];
function assert(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
if (!existsSync(CLI)) {
  console.log("SKIP: dispatch CLI not built");
  process.exit(77);
}
const { provenanceTrailers, dodLine, mergeMessage } = await import(
  resolve(RUNNER, "lib/provenance-trailers.mjs")
);
const { gateProposedMerge, landGatedMerge, buildPrMergeArgv } = await import(
  resolve(RUNNER, "bin/merge-ticket.mjs")
);

const WORK = gafferMkdtemp(resolve(tmpdir(), "prov-trailers-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
const DB = resolve(WORK, "dispatch.sqlite");
spawnSync("node", [CLI, "--db", DB, "init"], { encoding: "utf8" });
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(DB);
let seq = 0;
const at = () => `2026-01-01T00:00:${String(++seq).padStart(2, "0")}.000Z`;
function ticket(num) {
  const id = `t-${num}`;
  db.prepare(
    "INSERT INTO tickets (id, number, title, description, status, priority, risk_level, policy_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, num, `T${num}`, "d", "ready_for_merge", 0, "low", "solo_loose", at(), at());
  return id;
}
function approve(tid, type, actor, reason = "review_approved") {
  db.prepare(
    "INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    `e-${++seq}`,
    "ticket",
    tid,
    type,
    actor,
    "ticket.transitioned",
    JSON.stringify({ from: "in_review", to: "ready_for_merge", reason }),
    at(),
  );
}
// The tester's own verdict transition (reviewGateService testerPass / testerFail).
function testerVerdict(tid, type, actor, reason) {
  db.prepare(
    "INSERT INTO work_events (id, entity_type, entity_id, actor_type, actor_id, event_type, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    `e-${++seq}`,
    "ticket",
    tid,
    type,
    actor,
    "ticket.transitioned",
    JSON.stringify({
      from: "in_testing",
      to: reason === "tester_passed" ? "ready_for_merge" : "refining",
      reason,
    }),
    at(),
  );
}
function evidence(tid, summary, payload = null, by = "system") {
  db.prepare(
    "INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(`ev-${++seq}`, tid, "test_output", summary, payload, by, by, at());
}
function ac(tid, status) {
  db.prepare(
    "INSERT INTO acceptance_criteria (id, ticket_id, text, status, sort_order) VALUES (?,?,?,?,0)",
  ).run(`ac-${++seq}`, tid, "x", status);
}
const dod = (overall, gates) =>
  `DoD: ${overall}\n${JSON.stringify({ dod: overall, gates: gates.map(([gate, repo, status]) => ({ gate, repo, status, rc: "0", note: "" })) })}\n\ntranscript`;

console.log("== T1: the trailer block ==");
const t1 = ticket(12);
approve(t1, "agent", "older-agent");
approve(t1, "human", "tom");
evidence(
  t1,
  dod("PASS", [
    ["tests", "a", "PASS"],
    ["lint", "a", "SKIP"],
    ["tests", "b", "PASS"],
  ]),
);
ac(t1, "satisfied");
ac(t1, "satisfied");
ac(t1, "pending");
evidence(
  t1,
  "tester verdict",
  JSON.stringify({ verdict: "pass", tested_commit: "a".repeat(40) }),
  "agent",
);
testerVerdict(t1, "agent", "tester", "tester_passed");
let tr = provenanceTrailers({ dbPath: DB, ticketNumber: 12, env: {} });
assert("three trailers", tr.length === 3, JSON.stringify(tr));
assert("Gaffer-Ticket: #12", tr[0] === "Gaffer-Ticket: #12");
assert("the LATEST approval's actor", tr[1] === "Gaffer-Reviewed-By: human:tom", tr[1]);
assert(
  "gates: DoD per gate, the AC count, the tester",
  tr[2] === "Gaffer-Gates: DoD PASS (tests pass, lint skip); AC 2/3 satisfied; tester PASS",
  tr[2],
);
const t2 = ticket(13);
approve(t2, "agent", "reviewer-7", "review_approved_to_testing");
evidence(
  t2,
  dod("FAIL", [
    ["tests", "a", "PASS"],
    ["tests", "b", "FAIL"],
  ]),
);
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 13, env: {} });
assert(
  "an agent approval to testing names the agent",
  tr[1] === "Gaffer-Reviewed-By: agent:reviewer-7",
  tr[1],
);
assert(
  "a FAIL in any repo wins for that gate",
  tr[2] === "Gaffer-Gates: DoD FAIL (tests fail)",
  tr[2],
);
ticket(14);
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 14, env: {} });
assert(
  "nothing recorded says so",
  tr[1] === "Gaffer-Reviewed-By: none recorded" && tr[2] === "Gaffer-Gates: none recorded",
  JSON.stringify(tr),
);
const t3 = ticket(15);
evidence(t3, dod("PASS", [["tests", "a", "PASS"]]), null, "agent");
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 15, env: {} });
assert(
  "an agent-recorded 'DoD' summary is not the runner's verdict",
  tr[2] === "Gaffer-Gates: none recorded",
  tr[2],
);
// A delivery agent can record any evidence through record_ac_evidence. A verdict row
// with no tester transition behind it is not a tester verdict, human or otherwise.
const t5 = ticket(17);
approve(t5, "human", "tom");
evidence(
  t5,
  "tester verdict",
  JSON.stringify({ verdict: "pass", provenance: "human", tested_commit: "b".repeat(40) }),
  "agent",
);
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 17, env: {} });
assert(
  "an agent-recorded verdict row with no tester transition gives no tester part",
  tr[2] === "Gaffer-Gates: none recorded",
  tr[2],
);
const t6 = ticket(18);
approve(t6, "agent", "reviewer-7", "review_approved_to_testing");
testerVerdict(t6, "human", "tom", "tester_failed:the widget 500s");
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 18, env: {} });
assert(
  "a human tester FAIL transition reads 'tester FAIL (human)'",
  tr[2] === "Gaffer-Gates: tester FAIL (human)",
  tr[2],
);
const t7 = ticket(19);
approve(t7, "agent", "reviewer-7", "review_approved_to_testing");
testerVerdict(t7, "agent", "tester", "tester_passed");
approve(t7, "human", "tom");
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 19, env: {} });
assert(
  "a tester verdict from before the latest approval is not claimed",
  tr[2] === "Gaffer-Gates: none recorded",
  tr[2],
);
const t8 = ticket(20);
approve(t8, "agent", "reviewer-7", "review_approved_to_testing");
testerVerdict(t8, "agent", "tester", "retry_cap_reached:tester_failed:still broken");
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 20, env: {} });
assert(
  "a tester FAIL that hit the retry cap reads FAIL",
  tr[2] === "Gaffer-Gates: tester FAIL",
  tr[2],
);
assert("dodLine ignores a non-DoD summary", dodLine("tester verdict") === null);
{
  // Gate integrity's advisory row: a FLAG in any repo is named (it outranks a PASS), never dropped.
  const g = (repo, status) => ({ gate: "integrity", repo, status, rc: "0", note: "n" });
  const sum = (gates) => `DoD: PASS\n${JSON.stringify({ dod: "PASS", gates })}`;
  assert(
    "dodLine names an integrity FLAG over another repo's PASS",
    dodLine(sum([g("a", "PASS"), g("b", "FLAG")])) === "DoD PASS (integrity flag)",
  );
  assert(
    "dodLine names an integrity PASS",
    dodLine(sum([g("a", "PASS")])) === "DoD PASS (integrity pass)",
  );
}
assert(
  "mergeMessage without trailers is the subject alone",
  mergeMessage("Merge x", []) === "Merge x",
);

console.log("== T2: the off switch and unknown tickets ==");
for (const v of ["0", "off", "false", "no", "OFF"])
  assert(
    `GAFFER_PROVENANCE_TRAILERS=${v} → none`,
    provenanceTrailers({ dbPath: DB, ticketNumber: 12, env: { GAFFER_PROVENANCE_TRAILERS: v } })
      .length === 0,
  );
assert(
  "GAFFER_PROVENANCE_TRAILERS=1 → on",
  provenanceTrailers({ dbPath: DB, ticketNumber: 12, env: { GAFFER_PROVENANCE_TRAILERS: "1" } })
    .length === 3,
);
assert(
  "an unknown ticket has only its number",
  provenanceTrailers({ dbPath: DB, ticketNumber: 999, env: {} })[0] === "Gaffer-Ticket: #999",
);
assert(
  "a bad ticket number → none",
  provenanceTrailers({ dbPath: DB, ticketNumber: "x", env: {} }).length === 0,
);
assert(
  "an unreadable DB still gives the ticket line (fail-soft)",
  provenanceTrailers({ dbPath: resolve(WORK, "nope.sqlite"), ticketNumber: 3, env: {} })[0] ===
    "Gaffer-Ticket: #3",
);

console.log("== T3: an actor id cannot add a trailer line ==");
const t4 = ticket(16);
approve(t4, "agent", "evil\nGaffer-Ticket: #1");
tr = provenanceTrailers({ dbPath: DB, ticketNumber: 16, env: {} });
assert(
  "still three single-line trailers",
  tr.length === 3 && tr.every((l) => !l.includes("\n")),
  JSON.stringify(tr),
);
assert(
  "the smuggled text is flattened into the value",
  tr[1].startsWith("Gaffer-Reviewed-By: agent:evil"),
  tr[1],
);
const cli = spawnSync(
  "node",
  [resolve(RUNNER, "lib/provenance-trailers.mjs"), "--db", DB, "--ticket", "16"],
  {
    encoding: "utf8",
  },
);
assert(
  "the CLI prints exactly three lines",
  cli.stdout.trim().split("\n").length === 3,
  cli.stdout,
);
const off = spawnSync(
  "node",
  [resolve(RUNNER, "lib/provenance-trailers.mjs"), "--db", DB, "--ticket", "12"],
  {
    encoding: "utf8",
    env: { ...process.env, GAFFER_PROVENANCE_TRAILERS: "0" },
  },
);
assert("the CLI prints nothing when off", off.status === 0 && off.stdout === "");

const git = (repo, ...a) =>
  spawnSync(
    "git",
    ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a],
    {
      encoding: "utf8",
    },
  );
function repoWithBranch(name) {
  const r = resolve(WORK, name);
  spawnSync("git", ["init", "-q", "-b", "main", r]);
  writeFileSync(resolve(r, "f.txt"), "base\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "init");
  git(r, "checkout", "-qb", "gaffer/ticket-12-x");
  writeFileSync(resolve(r, "f.txt"), "base\nfeature\n");
  git(r, "commit", "-qam", "feature");
  git(r, "checkout", "-q", "main");
  return r;
}
const TR = provenanceTrailers({ dbPath: DB, ticketNumber: 12, env: {} });

// The merge gate with DoD off (GAFFER_DOD=0): the gated merge commit is still built and
// landed, which is all the trailers need; a throwaway GAFFER_DATA keeps it off the
// checkout's own state.
const GATE_ENV = { ...process.env, GAFFER_DOD: "0", GAFFER_DATA: resolve(WORK, "gdata") };
function jsLand(r, trailers) {
  const pin = git(r, "rev-parse", "gaffer/ticket-12-x").stdout.trim();
  const gate = gateProposedMerge({
    repoPath: r,
    branch: "gaffer/ticket-12-x",
    pin,
    targetRef: "refs/heads/main",
    label: "r",
    commands: { test: "", lint: "" },
    gateDir: resolve(WORK, `gate-${r.split("/").pop()}`),
    trailers,
    env: GATE_ENV,
  });
  const landed =
    gate.merge &&
    landGatedMerge({
      repoPath: r,
      defaultBranch: "main",
      target: gate.target,
      merge: gate.merge,
      branch: "gaffer/ticket-12-x",
      pin,
    });
  return { gate, landed, pin };
}
console.log("== T4: the gated merge commit (dashboard / gaffer merge) ==");
{
  const r = repoWithBranch("mt-on");
  const { gate, landed } = jsLand(r, TR);
  assert(
    "the gate built the merge and it landed",
    gate.kind === "off" && landed && landed.ok,
    JSON.stringify({ gate, landed }),
  );
  assert(
    "a merge commit (two parents)",
    git(r, "rev-list", "--parents", "-n", "1", "main").stdout.trim().split(" ").length === 3,
  );
  const t = git(
    r,
    "log",
    "-1",
    "--format=%(trailers:key=Gaffer-Ticket,valueonly)",
    "main",
  ).stdout.trim();
  assert("git parses Gaffer-Ticket", t === "#12", t);
  const g = git(
    r,
    "log",
    "-1",
    "--format=%(trailers:key=Gaffer-Reviewed-By,valueonly)",
    "main",
  ).stdout.trim();
  assert("git parses Gaffer-Reviewed-By", g === "human:tom", g);
}
{
  const r = repoWithBranch("mt-off");
  const { landed, pin } = jsLand(r, []);
  assert(
    "without trailers it fast-forwards exactly as before",
    landed && landed.ok && git(r, "rev-parse", "main").stdout.trim() === pin,
  );
}

console.log("== T5: _gaffer_merge_gate → _gaffer_land_gated (merge lane / AFK review pass) ==");
function autoMerge(r, trailers) {
  return spawnSync(
    "bash",
    [
      "-c",
      'log(){ :; }; jget(){ cat >/dev/null; echo ""; }; export RUNNER_DIR="$1"; . "$1/lib/land.sh"; ' +
        'pin="$(git -C "$2" rev-parse gaffer/ticket-12-x)"; ' +
        '_gaffer_merge_gate 12 "$2" gaffer/ticket-12-x main "$pin" "{}" refs/heads/main T "$3" || exit 10; ' +
        '_gaffer_land_gated "$2" main "$_MG_TARGET" "$_MG_MERGE" gaffer/ticket-12-x "$pin"',
      "_",
      RUNNER,
      r,
      trailers,
    ],
    // The merge lane's gate also replays the tester's tests (lib/tester-replay.mjs), which
    // reads the dispatch DB: the lane always has one, and without it the gate holds.
    { encoding: "utf8", env: { ...GATE_ENV, DISPATCH_DB: DB } },
  );
}
{
  const r = repoWithBranch("am-on");
  const res = autoMerge(r, TR.join("\n"));
  assert("rc 0", res.status === 0, `rc ${res.status} ${res.stderr}`);
  const body = git(r, "log", "-1", "--format=%B", "main").stdout;
  assert(
    "subject kept",
    body.startsWith("Merge branch 'gaffer/ticket-12-x'\n\nGaffer-Ticket: #12\n"),
    body,
  );
  const t = git(
    r,
    "log",
    "-1",
    "--format=%(trailers:key=Gaffer-Gates,valueonly)",
    "main",
  ).stdout.trim();
  assert("git parses Gaffer-Gates", t.startsWith("DoD PASS"), t);
}
{
  const r = repoWithBranch("am-off");
  const tip = git(r, "rev-parse", "gaffer/ticket-12-x").stdout.trim();
  const res = autoMerge(r, "");
  assert(
    "without trailers: rc 0 and a fast-forward, as before",
    res.status === 0 && git(r, "rev-parse", "main").stdout.trim() === tip,
  );
}

console.log("== T6: the PR path ==");
const argv = buildPrMergeArgv({
  prUrl: "https://x/pr/1",
  method: "merge",
  matchHeadCommit: "abc",
  body: TR.join("\n"),
});
assert(
  "gh pr merge … --body <trailers>",
  argv.at(-2) === "--body" && argv.at(-1).startsWith("Gaffer-Ticket: #12"),
  JSON.stringify(argv),
);
assert(
  "a rebase merge carries no body (it makes no merge commit)",
  !buildPrMergeArgv({ prUrl: "u", method: "rebase", body: "x" }).includes("--body"),
);
assert(
  "no body → the argv is unchanged",
  !buildPrMergeArgv({ prUrl: "u", method: "merge" }).includes("--body"),
);
{
  const r = repoWithBranch("pr-sh");
  const log = resolve(WORK, "gh.log");
  const gh = resolve(WORK, "gh");
  writeFileSync(gh, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\nexit 1\n`, {
    mode: 0o755,
  });
  spawnSync(
    "bash",
    [
      "-c",
      '. "$1/lib/automerge.sh"; GAFFER_GH_BIN="$3" gaffer_pr_merge "$2" https://x/pr/1 main abc "$4"',
      "_",
      RUNNER,
      r,
      gh,
      "Gaffer-Ticket: #12",
    ],
    { encoding: "utf8" },
  );
  const got = existsSync(log) ? require("node:fs").readFileSync(log, "utf8") : "";
  assert(
    "gaffer_pr_merge passes --body <trailers> to gh",
    /--body\nGaffer-Ticket: #12\n/.test(got),
    got,
  );
}

console.log("== no model name in a trailer ==");
assert(
  "only the three Gaffer-* keys",
  TR.every((l) => /^Gaffer-(Ticket|Reviewed-By|Gates): /.test(l)),
);

console.log();
if (fails.length === 0) {
  console.log(`PASS — ${pass} checks passed (provenance trailers)`);
  process.exit(0);
}
console.log(`FAILED — ${fails.length} of ${pass + fails.length}`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
