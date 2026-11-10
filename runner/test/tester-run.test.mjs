#!/usr/bin/env node
// =====================================================================
// `tester-run` helper (bin/tester-run.mjs) — BBT-001 independent black-box
// testing seam, proven WITHOUT a live model.
// ---------------------------------------------------------------------
// When a ticket is approved+testable with GAFFER_TESTING on, dispatch routes it
// in_review -> in_testing. THIS helper is the seam that assembles a CONTRACT-ONLY
// context (AC + test_contract — NEVER the diff) and records the tester's pass/fail
// verdict back through dispatch.
//
// Against the REAL helper (imported assembleContext + a real --dry-run subprocess
// + a stubbed verdict command over a throwaway sqlite DB), proves:
//   AC1  assembleContext returns the ticket's AC + parsed test_contract + mode
//   AC2  the assembled context DOES NOT contain the implementation diff/branch/pr
//   AC3  mode is "harness" when harness_ready is false, "black-box" when true
//   AC4  assembleContext returns null for a ticket that is NOT in_testing
//   AC5  --dry-run prints the contract-only context as JSON (exit 0, diff absent)
//   AC6  --verdict pass invokes the stub verdict cmd with (ticket, pass, summary)
//   AC7  --verdict fail invokes the stub verdict cmd with (ticket, fail, summary)
//   AC8  a missing --ticket is REFUSED (exit 1, error JSON)
//   AC9  a JSON-argv verdict command survives a path containing spaces
//
// Zero deps (node:sqlite ships with Node 22+). Run: node test/tester-run.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// node:sqlite (DatabaseSync) is a built-in only from Node 22.5+; skip cleanly on older Node.
try {
  require("node:sqlite");
} catch {
  console.log("  SKIP: node:sqlite unavailable (needs Node >= 22.5)");
  process.exit(0);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "..", "bin", "tester-run.mjs");
const { assembleContext, validateTesterPacket, implementationPointers, TESTER_PACKET_KEYS } =
  await import(HELPER);
// The description dispatch writes into every generated epic's acceptance ticket (the
// built module, so the test follows the real text).
const EPICS_JS = resolve(
  HERE,
  "..",
  "..",
  "packages",
  "dispatch",
  "dist",
  "services",
  "epicsService.js",
);
const GENERATED_ACCEPTANCE_DESCRIPTION = existsSync(EPICS_JS)
  ? (await import(EPICS_JS)).acceptanceTicketDescription("Notes", "a notes app")
  : "The independent tester then verifies the build from this ticket's contract and criteria only, never from the diff.";

let passed = 0;
const failures = [];
function ok(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label) {
  failures.push(label);
  console.log(`  FAIL ${label}`);
}
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// A sentinel only ever stored on the implementation fields (branch_name / pr_url).
// If it ever surfaces in the assembled context, the diff has leaked.
const IMPL_SENTINEL = "feat/secret-impl-branch-MUST-NOT-LEAK";
const PR_SENTINEL = "https://example.test/pr/SECRET";

// --- Build a throwaway dispatch sqlite with the tables assembleContext reads. ---
const WORKDIR = gafferMkdtemp(resolve(tmpdir(), "tester-run-test-"));
const DB_PATH = resolve(WORKDIR, "dispatch.sqlite");
const CONTRACT = {
  changed_surfaces: ["POST /api/widgets"],
  runtime_deps: ["Postgres 16 (was MySQL)"],
  env_vars: ["DATABASE_URL"],
  run_command: "docker compose up && curl localhost:3000/api/widgets",
  harness_ready: false,
};
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL, " +
      "description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, branch_name TEXT, pr_url TEXT, " +
      "can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT, acceptance INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE acceptance_criteria (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, " +
      "text TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');",
  );
  // #1: an in_testing ticket WITH an impl branch + pr recorded (the diff pointers
  // that must NOT leak), plus AC + a harness_ready=false contract.
  db.prepare(
    "INSERT INTO tickets (id,number,title,description,status,branch_name,pr_url,can_be_tested,test_contract) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "t1",
    1,
    "Widget endpoint",
    "deliver the widget endpoint",
    "in_testing",
    IMPL_SENTINEL,
    PR_SENTINEL,
    1,
    JSON.stringify(CONTRACT),
  );
  db.prepare(
    "INSERT INTO acceptance_criteria (id,ticket_id,text,sort_order,status) VALUES (?,?,?,?,?)",
  ).run("ac1", "t1", "POST /api/widgets returns 201 with the created widget", 0, "pending");
  // #2: a ticket NOT in_testing (in_review) — assembleContext must refuse it.
  db.prepare("INSERT INTO tickets (id,number,title,status,can_be_tested) VALUES (?,?,?,?,?)").run(
    "t2",
    2,
    "Not in testing",
    "in_review",
    1,
  );
  // #3: an in_testing ticket whose harness already exists (harness_ready=true).
  db.prepare(
    "INSERT INTO tickets (id,number,title,status,can_be_tested,test_contract) VALUES (?,?,?,?,?,?)",
  ).run(
    "t3",
    3,
    "Extend coverage",
    "in_testing",
    1,
    JSON.stringify({ ...CONTRACT, harness_ready: true }),
  );
  // #4: an epic ACCEPTANCE ticket with the description the factory generates (it says the
  // tester works "never from the diff") — the packet check used to refuse it on that word.
  db.prepare(
    "INSERT INTO tickets (id,number,title,description,status,branch_name,can_be_tested,test_contract,acceptance) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "t4",
    4,
    "Acceptance: Notes",
    GENERATED_ACCEPTANCE_DESCRIPTION,
    "in_testing",
    "gaffer/ticket-4-acceptance-notes",
    1,
    JSON.stringify(CONTRACT),
    1,
  );
  db.prepare(
    "INSERT INTO acceptance_criteria (id,ticket_id,text,sort_order,status) VALUES (?,?,?,?,?)",
  ).run("ac4", "t4", "the diff tool shows changes between two notes", 0, "pending");
  // #5: a ticket whose DESCRIPTION carries its own delivery branch (a real pointer).
  db.prepare(
    "INSERT INTO tickets (id,number,title,description,status,branch_name,can_be_tested,test_contract) " +
      "VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "t5",
    5,
    "Leaky",
    `see ${IMPL_SENTINEL} for the change`,
    "in_testing",
    IMPL_SENTINEL,
    1,
    JSON.stringify(CONTRACT),
  );
  db.close();
}

// Run the helper as a CLI; return { code, out }.
function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    env: { ...process.env, DISPATCH_DB: DB_PATH, ...env },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out };
}

console.log("== AC1: assembleContext returns AC + parsed contract + mode ==");
{
  const ctx = assembleContext(DB_PATH, 1);
  eq("number", ctx?.number, 1);
  eq("title", ctx?.title, "Widget endpoint");
  eq("acceptanceCriteria", ctx?.acceptanceCriteria, [
    { id: "ac1", text: "POST /api/widgets returns 201 with the created widget", status: "pending" },
  ]);
  eq("testContract", ctx?.testContract, CONTRACT);
}

console.log("== AC2: the assembled context DOES NOT contain the diff/branch/pr ==");
{
  const ctx = assembleContext(DB_PATH, 1);
  const blob = JSON.stringify(ctx);
  if (!blob.includes(IMPL_SENTINEL) && !blob.includes(PR_SENTINEL)) {
    ok("no impl branch / pr pointer in the tester context");
  } else fail(`impl pointer LEAKED into the context: ${blob}`);
}

console.log("== AC3: mode reflects harness_ready (harness vs black-box) ==");
eq("harness_ready=false → harness mode", assembleContext(DB_PATH, 1)?.mode, "harness");
eq("harness_ready=true → black-box mode", assembleContext(DB_PATH, 3)?.mode, "black-box");

console.log("== AC4: assembleContext refuses a ticket that is not in_testing ==");
eq("in_review ticket → null", assembleContext(DB_PATH, 2), null);

console.log("== AC5: --dry-run prints the contract-only context (exit 0, diff absent) ==");
{
  const { code, out } = runCli(["--ticket", "1", "--dry-run"]);
  const blob = JSON.stringify(out);
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.ticket === 1 &&
    out.context &&
    out.context.testContract &&
    !blob.includes(IMPL_SENTINEL) &&
    !blob.includes(PR_SENTINEL)
  ) {
    ok("dry-run → exit 0 + contract-only context, no diff");
  } else fail(`dry-run wrong (code=${code}, out=${blob})`);
}

console.log("== AC5b: the packet check reads FIELDS + real pointers, never prose ==");
{
  if (!/\bdiff\b/.test(GENERATED_ACCEPTANCE_DESCRIPTION))
    fail("fixture: the generated acceptance description no longer mentions the diff");
  const { code, out } = runCli(["--ticket", "4", "--dry-run"]);
  code === 0 && out?.phase === "dry-run" && out.context?.number === 4
    ? ok(
        "a generated epic acceptance ticket (description says 'never from the diff') is NOT refused",
      )
    : fail(`generated acceptance ticket refused (code=${code}, out=${JSON.stringify(out)})`);
  const leak = runCli(["--ticket", "5", "--dry-run"]);
  leak.code === 1 && /implementation pointer/.test(leak.out?.error ?? "")
    ? ok("a description carrying the ticket's own delivery branch IS refused")
    : fail(`leaky packet not refused (code=${leak.code}, out=${JSON.stringify(leak.out)})`);
  const ctx = assembleContext(DB_PATH, 4);
  eq(
    "packet keys are exactly the allowed set",
    Object.keys(ctx).sort(),
    [...TESTER_PACKET_KEYS].sort(),
  );
  const ptrs = implementationPointers(DB_PATH, 4);
  eq("pointers read from the DB", ptrs, ["gaffer/ticket-4-acceptance-notes"]);
  eq("valid packet", validateTesterPacket(ctx, ptrs), { ok: true });
  eq(
    "an extra field is refused",
    validateTesterPacket({ ...ctx, branch_name: "x" }, ptrs).ok,
    false,
  );
  eq(
    "an extra criterion field is refused",
    validateTesterPacket({ ...ctx, acceptanceCriteria: [{ id: "a", text: "t", diff: "x" }] }, ptrs)
      .ok,
    false,
  );
  eq("unreadable pointers fail closed", validateTesterPacket(ctx, null).ok, false);
}

// --- A stub verdict command that records its argv to a file (no live model). ---
const STUB_LOG = resolve(WORKDIR, "verdict.log");
const STUB = resolve(WORKDIR, "stub-verdict.mjs");
writeFileSync(
  STUB,
  "#!/usr/bin/env node\n" +
    "import { appendFileSync } from 'node:fs';\n" +
    `appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    "process.exit(0);\n",
);
chmodSync(STUB, 0o755);
const STUB_CMD = `${process.execPath} ${STUB}`;

console.log("== AC6: --verdict pass invokes the stub with (ticket, pass, summary) ==");
{
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  const { code, out } = runCli(
    ["--ticket", "1", "--verdict", "pass", "--summary", "12 tests pass"],
    {
      DISPATCH_TESTER_VERDICT_CMD: STUB_CMD,
    },
  );
  const logged = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  if (
    code === 0 &&
    out &&
    out.phase === "verdict" &&
    out.verdict === "pass" &&
    logged.includes('"1"') &&
    logged.includes('"pass"') &&
    logged.includes("12 tests pass")
  ) {
    ok("pass verdict → stub invoked with ticket+pass+summary, transition recorded");
  } else fail(`pass verdict wrong (code=${code}, out=${JSON.stringify(out)}, log=${logged})`);
}

console.log("== AC7: --verdict fail invokes the stub with (ticket, fail, summary) ==");
{
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  const { code, out } = runCli(["--ticket", "1", "--verdict", "fail", "--summary", "AC fails"], {
    DISPATCH_TESTER_VERDICT_CMD: STUB_CMD,
  });
  const logged = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  if (
    code === 0 &&
    out &&
    out.phase === "verdict" &&
    out.verdict === "fail" &&
    logged.includes('"fail"') &&
    logged.includes("AC fails")
  ) {
    ok("fail verdict → stub invoked with ticket+fail+summary, transition recorded");
  } else fail(`fail verdict wrong (code=${code}, out=${JSON.stringify(out)}, log=${logged})`);
}

console.log("== AC8: a missing --ticket is REFUSED ==");
{
  const { code, out } = runCli(["--dry-run"]);
  if (code !== 0 && out && out.phase === "error" && /ticket/i.test(out.error)) {
    ok("missing --ticket → exit 1 + error JSON");
  } else fail(`missing-ticket refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC9: a JSON-argv verdict command survives a path with spaces ==");
{
  // A stub whose path CONTAINS A SPACE — a whitespace-split override would break it;
  // a JSON argv array keeps it one token.
  const SPACED = resolve(WORKDIR, "stub verdict.mjs");
  writeFileSync(
    SPACED,
    "#!/usr/bin/env node\n" +
      "import { appendFileSync } from 'node:fs';\n" +
      `appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
      "process.exit(0);\n",
  );
  chmodSync(SPACED, 0o755);
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  const { code, out } = runCli(["--ticket", "1", "--verdict", "pass", "--summary", "ok"], {
    DISPATCH_TESTER_VERDICT_CMD: JSON.stringify([process.execPath, SPACED]),
  });
  const logged = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  if (code === 0 && out && out.phase === "verdict" && logged.includes('"pass"')) {
    ok("JSON-argv verdict cmd with a spaced path invoked correctly");
  } else
    fail(`spaced-path verdict wrong (code=${code}, out=${JSON.stringify(out)}, log=${logged})`);
}

console.log("== AC9b: a PASS that binds identities names WHO TESTED (system-only flags) ==");
{
  const { recordVerdict, TESTER_AGENT_ID } = await import("../bin/tester-run.mjs");
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  const env = { ...process.env, DISPATCH_TESTER_VERDICT_CMD: STUB_CMD };
  const r1 = recordVerdict(1, "pass", "ok", env, {
    testsCommit: "a".repeat(40),
    tests: [{ file: "test/a.test.mjs", name: "smoke" }],
    testerAgent: { id: TESTER_AGENT_ID, run: "sess-1" },
  });
  const withIds = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  rmSync(STUB_LOG, { force: true });
  // Without identities the PASS is the tester agent's own (--as agent): no who-tested flags.
  recordVerdict(1, "pass", "ok", env, { testerAgent: { id: TESTER_AGENT_ID, run: "sess-1" } });
  const plain = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  if (
    r1.ok &&
    withIds.includes('"--tester-agent","tester","--tester-run","sess-1"') &&
    withIds.includes('"--tests-json"') &&
    !plain.includes("--tester-agent")
  )
    ok("identities ride with --tester-agent/--tester-run; a plain agent PASS carries neither");
  else fail(`who-tested flags wrong (ids=${withIds}, plain=${plain})`);
}

// ── AC10–AC12: --live runs the INDEPENDENT tester agent lane end to end (stub claude) ──
console.log(
  "== AC10: --live spawns the tester in a worktree of the delivery branch and records PASS ==",
);
const LANE_LOG = resolve(WORKDIR, "lane-verdicts.jsonl");
const laneLines = () =>
  existsSync(LANE_LOG)
    ? readFileSync(LANE_LOG, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const LIVE = (() => {
  // Repo with a delivery branch; the ticket's ticket_repos row points at it.
  const repo = resolve(WORKDIR, "live-repo");
  const g = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  require("node:fs").mkdirSync(resolve(repo, "src"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(
    resolve(repo, "package.json"),
    '{"name":"live","type":"module","scripts":{"test":"node --test"}}\n',
  );
  writeFileSync(resolve(repo, "src", "w.js"), "export const w = 1;\n");
  // A build step whose output git ignores — the clean replay rebuilds it from src.
  writeFileSync(
    resolve(repo, "build.js"),
    'import { mkdirSync, writeFileSync } from "node:fs"; import { w } from "./src/w.js"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/out.js", `export const out = ${w};\\n`);\n',
  );
  writeFileSync(resolve(repo, ".gitignore"), "dist/\nnode_modules/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "gaffer/ticket-1-widgets");
  writeFileSync(resolve(repo, "src", "w.js"), "export const w = 2;\n");
  g("commit", "-q", "-am", "feat: widgets");
  g("checkout", "-q", "main");
  const deliverySha = g("rev-parse", "gaffer/ticket-1-widgets").stdout.trim();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main', stack TEXT, test_command TEXT);" +
      "CREATE TABLE IF NOT EXISTS ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT DEFAULT 'primary', branch_name TEXT, access TEXT DEFAULT 'write');",
  );
  db.prepare(
    "INSERT INTO repositories (id,name,local_path,default_branch,stack,test_command) VALUES (?,?,?,?,?,?)",
  ).run("r1", "live", repo, "main", "typescript-node", "node build.js && node --test");
  db.prepare(
    "INSERT INTO ticket_repos (ticket_id,repo_id,role,branch_name,access) VALUES (?,?,?,?,?)",
  ).run("t1", "r1", "primary", "gaffer/ticket-1-widgets", "write");
  db.close();
  // Stub claude: captures its prompt + cwd, writes a black-box test into the worktree,
  // prints a claude JSON envelope whose result ends with the verdict token named by
  // the TESTER_STUB_VERDICT env (PASS | FAIL | none).
  const stub = resolve(WORKDIR, "claude-stub.sh");
  const capture = resolve(WORKDIR, "tester-capture.json");
  writeFileSync(
    stub,
    "#!/usr/bin/env bash\nset -uo pipefail\n" +
      'prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done\n' +
      `node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),prompt:process.argv[2],skills:fs.existsSync(".claude/skills")?fs.readdirSync(".claude/skills").sort():null,settings:fs.existsSync(".claude/settings.json"),brief:fs.existsSync("CLAUDE.factory.md")}))' ${JSON.stringify(capture)} "$prompt"\n` +
      'mkdir -p test && printf \'import test from "node:test"; import assert from "node:assert/strict"; import { w } from "../src/w.js"; test("bb", () => assert.equal(w, 2));\\n\' > test/bb.test.js\n' +
      // TESTER_STUB_DIST=1: the agent edits IGNORED build output (dist/) and tests against
      // it — invisible to git status; only the clean replay (which rebuilds) can catch it.
      '[ "${TESTER_STUB_DIST:-0}" = "1" ] && mkdir -p dist && printf \'export const out = 3;\\n\' > dist/out.js && printf \'import test from "node:test"; import assert from "node:assert/strict"; import { out } from "../dist/out.js"; test("dist", () => assert.equal(out, 3));\\n\' > test/dist.test.js\n' +
      // TESTER_STUB_BREAKGIT=1: the worktree's git link disappears — uninspectable.
      '[ "${TESTER_STUB_BREAKGIT:-0}" = "1" ] && rm -f .git\n' +
      // TESTER_STUB_MUTATE=1: the agent "fixes" the implementation to make its test pass —
      // the verdict is then not about the candidate and must be HELD, never recorded.
      '[ "${TESTER_STUB_MUTATE:-0}" = "1" ] && printf \'export const w = 2; // tester edit\\n\' > src/w.js\n' +
      // The agent COMMITS in the worktree (seen live): with a detached HEAD this can never
      // advance the reviewed delivery branch; the commit is moved to the tests branch.
      'git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -q -m "agent committed its tests" >/dev/null 2>&1 || true\n' +
      'case "${TESTER_STUB_VERDICT:-PASS}" in\n' +
      '  PASS) printf \'{"type":"result","subtype":"success","is_error":false,"result":"PASS: every AC demonstrated\\\\n{\\\\"verdict\\\\":\\\\"PASS\\\\"}","total_cost_usd":0.01,"num_turns":3}\\n\' ;;\n' +
      '  FAIL) printf \'{"type":"result","subtype":"success","is_error":false,"result":"FAIL: AC1 POST /api/widgets returned 500, expected 201\\\\n{\\\\"verdict\\\\":\\\\"FAIL\\\\"}","total_cost_usd":0.01,"num_turns":3}\\n\' ;;\n' +
      // LIMIT: the call is refused by the usage window (Claude Code 2.1.316's wording,
      // is_error:true, exit 1). LIAR: the agent's own reply quotes those words.
      '  LIMIT) printf \'{"type":"result","subtype":"success","is_error":true,"result":"You\\x27ve hit your 5-hour limit \u00b7 resets 11:58pm (UTC) \u00b7 progress saved","total_cost_usd":0,"num_turns":1}\\n\'; exit 1 ;;\n' +
      '  LIAR) printf \'{"type":"result","subtype":"success","is_error":false,"result":"You\\x27ve hit your 5-hour limit \u00b7 resets 11:58pm (UTC)","total_cost_usd":0.01,"num_turns":4}\\n\' ;;\n' +
      '  *) printf \'{"type":"result","subtype":"success","is_error":false,"result":"I think it passes.","total_cost_usd":0.01,"num_turns":1}\\n\' ;;\n' +
      "esac\n",
  );
  chmodSync(stub, 0o755);
  const verdictStub = resolve(WORKDIR, "verdict-stub.mjs");
  writeFileSync(
    verdictStub,
    "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\n" +
      `appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(0);\n`,
  );
  const laneStub = resolve(WORKDIR, "lane-stub.mjs");
  writeFileSync(
    laneStub,
    "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\n" +
      `appendFileSync(${JSON.stringify(LANE_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(0);\n`,
  );
  const data = resolve(WORKDIR, "data");
  require("node:fs").mkdirSync(data, { recursive: true });
  return { repo, g, deliverySha, stub, capture, verdictStub, laneStub, data };
})();
function runLive(verdictMode, extraEnv = {}) {
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  if (existsSync(LANE_LOG)) rmSync(LANE_LOG);
  if (existsSync(LIVE.capture)) rmSync(LIVE.capture);
  const { code, out } = runCli(["--ticket", "1", "--live"], {
    GAFFER_DATA: LIVE.data,
    CLAUDE_BIN: LIVE.stub,
    CLAUDE_FLAGS: "",
    TESTER_STUB_VERDICT: verdictMode,
    ...extraEnv,
    DISPATCH_TESTER_VERDICT_CMD: JSON.stringify([process.execPath, LIVE.verdictStub]),
    DISPATCH_LANE_VERDICT_CMD: JSON.stringify([process.execPath, LIVE.laneStub]),
  });
  const logged = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").trim() : "";
  const cap = existsSync(LIVE.capture) ? JSON.parse(readFileSync(LIVE.capture, "utf8")) : null;
  return { code, out, logged, cap };
}
{
  const { code, out, logged, cap } = runLive("PASS");
  if (code === 0 && out && out.phase === "verdict" && out.verdict === "pass")
    ok("PASS verdict recorded (phase=verdict, exit 0)");
  else fail(`live PASS wrong (code=${code}, out=${JSON.stringify(out)})`);
  logged.includes('"pass"') && logged.includes('"1"')
    ? ok("verdict seam invoked with (1, pass, summary)")
    : fail(`seam log: ${logged}`);
  // MF2: the tester lane's verdict is recorded as a system lane verdict on the tested commit.
  const lane = laneLines();
  lane.length === 1 &&
  lane[0].join(" ").startsWith("ticket lane-verdict 1 --lane tester --verdict pass") &&
  lane[0].includes(LIVE.deliverySha) &&
  lane[0].includes("system")
    ? ok("the tester lane verdict (pass, tested commit, as system) is recorded")
    : fail(`lane verdict argv: ${JSON.stringify(lane)}`);
  // MF4: the tester's ledger row carries its repo (and the risk when the ticket has one).
  const ledgerRows = existsSync(resolve(LIVE.data, "usage-ledger.jsonl"))
    ? readFileSync(resolve(LIVE.data, "usage-ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
  const testerRow = ledgerRows.filter((r) => r.kind === "tester").pop();
  testerRow && testerRow.repo === "live"
    ? ok("the tester's ledger row carries the repo it tested")
    : fail(`tester ledger row: ${JSON.stringify(testerRow)}`);
  // ACCEPTANCE GATE: the verdict is bound to the tested commit and the contract hash.
  logged.includes('"--tested-commit"') && logged.includes(JSON.stringify(LIVE.deliverySha))
    ? ok("verdict carries --tested-commit <the delivery head it ran against>")
    : fail(`no tested-commit binding in the verdict argv: ${logged}`);
  /"--contract-hash","[0-9a-f]{64}"/.test(logged)
    ? ok("verdict carries --contract-hash <sha256 of the contract>")
    : fail(`no contract-hash binding in the verdict argv: ${logged}`);
  logged.includes('"--replay","passed"') && out && out.replay === "passed"
    ? ok("the PASS survived a clean replay on the tested commit (--replay passed)")
    : fail(`replay not passed/recorded: ${logged} / ${JSON.stringify(out && out.replay)}`);
  out && out.testedCommit === LIVE.deliverySha && /^[0-9a-f]{64}$/.test(out.contractHash || "")
    ? ok("emitted JSON names the tested commit and contract hash")
    : fail(
        `emitted binding: ${JSON.stringify({ c: out && out.testedCommit, h: out && out.contractHash })}`,
      );
  cap && cap.cwd.includes(`worktrees${require("node:path").sep}tester-1`)
    ? ok("tester ran in the throwaway worktree of the delivery branch")
    : fail(`cwd: ${cap && cap.cwd}`);
  cap && !cap.prompt.includes(IMPL_SENTINEL) && !cap.prompt.includes(PR_SENTINEL)
    ? ok("prompt carries no implementation pointer (branch/pr sentinels absent)")
    : fail("prompt leaked an implementation pointer");
  cap &&
  /black-box-test skill/.test(cap.prompt) &&
  /"verdict":"PASS"/.test(cap.prompt) &&
  /POST \/api\/widgets returns 201/.test(cap.prompt)
    ? ok("prompt names the skill, the verdict token and the ACs")
    : fail(`prompt content wrong: ${cap && cap.prompt.slice(0, 200)}`);
  cap &&
  Array.isArray(cap.skills) &&
  cap.skills.includes("black-box-test") &&
  cap.skills.includes("typescript-conventions") &&
  !cap.skills.includes("add-api-endpoint")
    ? ok("test-role skills mounted (black-box-test + the stack's conventions pack, no build packs)")
    : fail(`skills mounted: ${cap && JSON.stringify(cap.skills)}`);
  cap && cap.settings && cap.brief
    ? ok("settings.json (safety hook) + CLAUDE.factory.md installed in the worktree")
    : fail("agent wiring missing");
  LIVE.g("rev-parse", "gaffer/ticket-1-widgets").stdout.trim() === LIVE.deliverySha
    ? ok("the reviewed delivery branch is untouched")
    : fail("delivery branch moved");
  const testsSha = LIVE.g("rev-parse", "--verify", "gaffer-tests/ticket-1").status;
  testsSha === 0 && LIVE.g("show", "gaffer-tests/ticket-1:test/bb.test.js").status === 0
    ? ok("the tester's tests are kept on gaffer-tests/ticket-1")
    : fail("tests branch missing or without the test file");
  out && out.testsBranch === "gaffer-tests/ticket-1"
    ? ok("emitted JSON names the tests branch")
    : fail(`testsBranch: ${out && out.testsBranch}`);
  // TESTER REPLAY: the PASS is bound to the exact commit holding THIS run's tests, so the
  // landing replays those files — not whatever the branch points at by then.
  const testsHead = LIVE.g("rev-parse", "--verify", "gaffer-tests/ticket-1").stdout.trim();
  /^[0-9a-f]{40}$/.test(testsHead) &&
  logged.includes(`"--tests-commit","${testsHead}"`) &&
  out &&
  out.testsCommit === testsHead
    ? ok("verdict carries --tests-commit <the commit holding the tester's tests>")
    : fail(`no tests-commit binding: ${logged} / ${JSON.stringify(out && out.testsCommit)}`);
  // BACKPRESSURE: the real lib/backpressure.sh counts unmerged gaffer/* branches toward
  // the repo's cap. The tests branch is never merged, so it must not be one of them —
  // under the old gaffer/ticket-<n>-tests name, three tested tickets stopped the repo.
  const bp = spawnSync(
    "bash",
    [
      "-c",
      'source "$0" && gaffer_repo_unmerged_branches "$1" main',
      resolve(HERE, "..", "lib", "backpressure.sh"),
      LIVE.repo,
    ],
    { encoding: "utf8" },
  );
  (bp.stdout || "").trim() === "1"
    ? ok("backpressure counts only the delivery branch, not the tests branch")
    : fail(`unmerged gaffer/* branches after the tester ran: ${(bp.stdout || "").trim()} (want 1)`);
  !existsSync(resolve(LIVE.data, "worktrees", "tester-1"))
    ? ok("tester worktree removed")
    : fail("worktree left behind");
  !existsSync(resolve(LIVE.data, "mcp-tester-1.json"))
    ? ok("scoped MCP runtime removed after the run")
    : fail("mcp runtime left behind");
  const ledger = resolve(LIVE.data, "usage-ledger.jsonl");
  existsSync(ledger) && readFileSync(ledger, "utf8").includes('"kind":"tester"')
    ? ok("usage ledgered as kind=tester")
    : fail("no tester ledger row");
}
console.log("== AC11: --live records FAIL when the tester's token says so ==");
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { code, out, logged } = runLive("FAIL");
  code === 0 && out && out.verdict === "fail"
    ? ok("FAIL verdict recorded")
    : fail(`live FAIL wrong (code=${code}, out=${JSON.stringify(out)})`);
  logged.includes('"fail"') && /returned 500/.test(logged)
    ? ok("seam got fail + the tester's summary line")
    : fail(`seam log: ${logged}`);
}
console.log("== AC12: no verdict token → HELD (exit 2), nothing recorded ==");
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { code, out, logged } = runLive("NONE");
  code === 2 && out && out.phase === "held"
    ? ok("no token → phase=held, exit 2")
    : fail(`held wrong (code=${code}, out=${JSON.stringify(out)})`);
  logged === ""
    ? ok("no verdict recorded on silence (never a pass)")
    : fail(`seam was invoked: ${logged}`);
  const lane = laneLines();
  lane.length === 1 &&
  lane[0].includes("held") &&
  lane[0].includes("--held-reason") &&
  /no verdict token/.test(lane[0].join(" "))
    ? ok("a held tester run is recorded as a held lane verdict with its reason")
    : fail(`held lane verdict argv: ${JSON.stringify(lane)}`);
}

console.log(
  "== AC12b: a tester REFUSED by the usage window is not a hold for a human (phase usage_limited) ==",
);
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const envOut = resolve(WORKDIR, "tester-envelope.json");
  if (existsSync(envOut)) rmSync(envOut);
  const { code, out, logged } = runLive("LIMIT", { GAFFER_TESTER_ENVELOPE_OUT: envOut });
  code === 3 && out && out.phase === "usage_limited" && out.ticket === 1
    ? ok("refused tester → phase=usage_limited, exit 3 (not held)")
    : fail(`refused tester wrong (code=${code}, out=${JSON.stringify(out)})`);
  out && /5-hour limit/.test(out.reason || "") && out.kind === "usage_limit"
    ? ok("the output quotes what the CLI said and its kind")
    : fail(`usage_limited output lacks the reason/kind: ${JSON.stringify(out)}`);
  logged === "" ? ok("no verdict recorded on a refusal") : fail(`seam was invoked: ${logged}`);
  existsSync(envOut) && /"is_error":true/.test(readFileSync(envOut, "utf8"))
    ? ok("the raw envelope is written to GAFFER_TESTER_ENVELOPE_OUT for the runner's pause record")
    : fail("no envelope at GAFFER_TESTER_ENVELOPE_OUT");
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const liar = runLive("LIAR", { GAFFER_TESTER_ENVELOPE_OUT: envOut });
  liar.code === 2 && liar.out && liar.out.phase === "held"
    ? ok("the same words in the agent's own reply (success envelope) → held, as before")
    : fail(`liar wrong (code=${liar.code}, out=${JSON.stringify(liar.out)})`);
}

console.log(
  "== AC12c: a usage-window PAUSE in force: no tester spawned, not a hold, nothing booked ==",
);
{
  // lib/worker.mjs deliver() refuses a paid launch while $GAFFER_DATA/usage-pause.json is
  // in force (status 75, usagePaused). The tester must read that as the usage window it
  // is (the runner skips the ticket for this run), not as "no verdict token" (a hold for
  // a human that is remembered for the whole stay in_testing).
  const branches = LIVE.g("branch", "--list", "gaffer-tests/ticket-1").stdout.trim();
  if (branches) LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const pauseFile = resolve(LIVE.data, "usage-pause.json");
  const ledger = resolve(LIVE.data, "usage-ledger.jsonl");
  const until = Date.now() + 3600e3;
  writeFileSync(
    pauseFile,
    JSON.stringify({
      paused_until: new Date(until).toISOString(),
      until_ms: until,
      kind: "usage_limit",
      basis: "default",
      message: "stub limit",
      ticket: null,
      lane: "delivery",
      recorded_at: new Date().toISOString(),
    }),
  );
  const ledgerBefore = existsSync(ledger) ? readFileSync(ledger, "utf8") : "";
  const { code, out, logged, cap } = runLive("PASS");
  rmSync(pauseFile, { force: true });
  cap === null
    ? ok("no tester agent spawned while paused")
    : fail("the stub claude ran while paused");
  code === 3 && out && out.phase === "usage_paused" && out.ticket === 1
    ? ok("paused tester → phase=usage_paused, exit 3 (not held)")
    : fail(`paused tester wrong (code=${code}, out=${JSON.stringify(out)})`);
  out && /paused until/.test(out.reason || "")
    ? ok("the output names the pause")
    : fail(`usage_paused output lacks the pause: ${JSON.stringify(out)}`);
  logged === "" ? ok("no verdict recorded while paused") : fail(`seam was invoked: ${logged}`);
  (existsSync(ledger) ? readFileSync(ledger, "utf8") : "") === ledgerBefore
    ? ok("the usage ledger booked nothing for the refused launch")
    : fail(
        `the ledger gained a row: ${(existsSync(ledger) ? readFileSync(ledger, "utf8") : "").slice(ledgerBefore.length)}`,
      );
}

console.log(
  "== AC13: --live HOLDS when the tester modified the implementation (verdict not about the candidate) ==",
);
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { code, out, logged } = runLive("PASS", { TESTER_STUB_MUTATE: "1" });
  code === 2 &&
  out &&
  out.phase === "held" &&
  /modified implementation files/.test(out.reason || "")
    ? ok("a PASS from a tester that edited src/ is HELD (exit 2), not recorded")
    : fail(`mutating tester not held (code=${code}, out=${JSON.stringify(out)})`);
  Array.isArray(out && out.implementationChanges) && out.implementationChanges.includes("src/w.js")
    ? ok("the held reason names the implementation file the tester changed")
    : fail(`implementationChanges: ${JSON.stringify(out && out.implementationChanges)}`);
  logged === ""
    ? ok("no verdict was recorded through the seam")
    : fail(`a verdict was recorded: ${logged}`);
  LIVE.g("rev-parse", "gaffer/ticket-1-widgets").stdout.trim() === LIVE.deliverySha
    ? ok("the reviewed delivery branch is still untouched")
    : fail("delivery branch moved");
}

console.log(
  "== AC15: a PASS whose tester changed IGNORED build output fails the clean replay → HELD ==",
);
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { code, out, logged } = runLive("PASS", { TESTER_STUB_DIST: "1" });
  code === 2 && out && out.phase === "held" && /clean replay failed/.test(out.reason || "")
    ? ok(
        "tampered dist/ (git-ignored) is caught: the replay rebuilds from src and the tester's test fails → held",
      )
    : fail(`dist tamper not caught (code=${code}, out=${JSON.stringify(out)})`);
  logged === "" ? ok("no verdict recorded") : fail(`a verdict was recorded: ${logged}`);
  out && out.replay && out.replay.state === "failed" && /exited/.test(out.replay.reason || "")
    ? ok("the held output names the failed replay and its exit")
    : fail(`replay detail: ${JSON.stringify(out && out.replay)}`);
}
console.log(
  "== AC16: an uninspectable tester worktree (git fails) HOLDS — never read as 'nothing changed' ==",
);
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { code, out, logged } = runLive("PASS", { TESTER_STUB_BREAKGIT: "1" });
  code === 2 && out && out.phase === "held" && /could not inspect/.test(out.reason || "")
    ? ok("git inspection failure → held (exit 2)")
    : fail(`broken git not held (code=${code}, out=${JSON.stringify(out)})`);
  logged === "" ? ok("no verdict recorded") : fail(`a verdict was recorded: ${logged}`);
  LIVE.g("worktree", "prune");
}
console.log("== AC17: an ACCEPTANCE ticket's PASS without a replay that ran HOLDS ==");
{
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.prepare("UPDATE tickets SET acceptance = 1 WHERE id = 't1'").run();
  db.prepare("UPDATE repositories SET test_command = NULL WHERE id = 'r1'").run();
  db.close();
  const { code, out, logged } = runLive("PASS");
  code === 2 &&
  out &&
  out.phase === "held" &&
  /acceptance PASS without a clean replay/.test(out.reason || "")
    ? ok("no test command to replay → the acceptance PASS is held, not recorded unbound")
    : fail(`acceptance without replay not held (code=${code}, out=${JSON.stringify(out)})`);
  logged === "" ? ok("no verdict recorded") : fail(`a verdict was recorded: ${logged}`);
  const db2 = new DatabaseSync(DB_PATH);
  db2.prepare("UPDATE tickets SET acceptance = 0 WHERE id = 't1'").run();
  db2
    .prepare(
      "UPDATE repositories SET test_command = 'node build.js && node --test' WHERE id = 'r1'",
    )
    .run();
  db2.close();
}
console.log(
  "== AC17b: an ORDINARY ticket's PASS without a replay that ran HOLDS (unverified), never records ==",
);
{
  // False green (STRATEGY section 2): with no registered test command the runner cannot
  // replay the tester's tests on a clean checkout, so the PASS proves nothing about the
  // candidate. It used to record (--replay skipped) and land as tester-passed.
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.prepare("UPDATE repositories SET test_command = NULL WHERE id = 'r1'").run();
  db.close();
  const { code, out, logged } = runLive("PASS");
  code === 2 && out && out.phase === "held"
    ? ok(
        "no test command → an ordinary ticket's PASS is HELD (exit 2), the same outcome as every other hold",
      )
    : fail(`ordinary PASS without replay not held (code=${code}, out=${JSON.stringify(out)})`);
  logged === "" ? ok("no verdict recorded") : fail(`a verdict was recorded: ${logged}`);
  /^unverified: no test command registered for repo live\b/.test((out && out.reason) || "")
    ? ok("the reason starts 'unverified: no test command registered for repo live'")
    : fail(`reason: ${JSON.stringify(out && out.reason)}`);
  /wg repo set-commands live --test/.test((out && out.reason) || "") &&
  /Referee's checks/.test((out && out.reason) || "") &&
  /GAFFER_PRINCIPAL_TOKEN=<token> gaffer wg ticket tester-pass \d+/.test(
    (out && out.reason) || "",
  ) &&
  !/--as human/.test((out && out.reason) || "")
    ? ok(
        "the reason says how to register one (CLI and dashboard) and how a person moves it on (a principal's token, package H1)",
      )
    : fail(`reason lacks the how-to: ${JSON.stringify(out && out.reason)}`);
  out && out.unverified === true && out.replay && out.replay.state === "skipped"
    ? ok("the held output carries unverified:true and the skipped replay")
    : fail(`held detail: ${JSON.stringify(out)}`);
  // The replay switched off (GAFFER_TESTER_REPLAY=0) is the same: nothing replayed.
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const db2 = new DatabaseSync(DB_PATH);
  db2
    .prepare(
      "UPDATE repositories SET test_command = 'node build.js && node --test' WHERE id = 'r1'",
    )
    .run();
  db2.close();
  const off = runLive("PASS", { GAFFER_TESTER_REPLAY: "0" });
  off.code === 2 &&
  off.out &&
  off.out.phase === "held" &&
  /^unverified: the clean replay is switched off \(GAFFER_TESTER_REPLAY is 0\)/.test(
    off.out.reason || "",
  )
    ? ok("GAFFER_TESTER_REPLAY=0 → an ordinary PASS is held as unverified, not recorded")
    : fail(`replay-off PASS not held (code=${off.code}, out=${JSON.stringify(off.out)})`);
  off.logged === ""
    ? ok("no verdict recorded with the replay off")
    : fail(`recorded: ${off.logged}`);
  // CONTAINMENT (external review 11): strict mode asks for an OS sandbox and this host
  // cannot supply one (the docker provider with no reachable daemon): the clean replay
  // never runs the tester's files unsandboxed, it HOLDS, and the PASS is held unverified.
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const nosb = runLive("PASS", {
    STRICT_MODE: "1",
    SANDBOX_PROVIDER: "docker",
    DOCKER_HOST: "unix:///nonexistent/gaffer-test-docker.sock",
  });
  nosb.code === 2 &&
  nosb.out &&
  nosb.out.phase === "held" &&
  nosb.out.unverified === true &&
  nosb.out.replay &&
  nosb.out.replay.state === "held" &&
  /^unverified: the clean replay was held \(.*OS sandbox.*SANDBOX_PROVIDER=docker/.test(
    nosb.out.reason || "",
  )
    ? ok(
        "STRICT_MODE=1 with no sandbox on the host: the PASS is held unverified, the sandbox named",
      )
    : fail(`no-sandbox strict PASS not held (code=${nosb.code}, out=${JSON.stringify(nosb.out)})`);
  nosb.logged === ""
    ? ok("no verdict recorded when the replay could not be sandboxed")
    : fail(`recorded: ${nosb.logged}`);
  // A FAIL needs no replay: it is recorded as before (a FAIL is never a false green).
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
  const f = runLive("FAIL", { GAFFER_TESTER_REPLAY: "0" });
  f.code === 0 && f.out && f.out.phase === "verdict" && f.out.verdict === "fail"
    ? ok("a FAIL with the replay off is still recorded")
    : fail(`FAIL with replay off: code=${f.code} out=${JSON.stringify(f.out)}`);
  LIVE.g("branch", "-D", "gaffer-tests/ticket-1");
}
console.log(
  "== AC17c: the unverified hold's register command quotes a repo name a shell would split ==",
);
{
  const { unverifiedPassReason } = await import(HELPER);
  const cmd = (repoName) =>
    (unverifiedPassReason({
      replay: { state: "skipped", reason: "the repo has no test command registered" },
      repoName,
      ticket: 3,
    }).match(/`wg repo set-commands (.*?) --test/) || [])[1];
  cmd("live") === "live"
    ? ok("a plain repo name is left as it is")
    : fail(`plain name: ${cmd("live")}`);
  cmd("my app") === "'my app'" && cmd("$(id)") === "'$(id)'" && cmd("o'b") === "'o'\\''b'"
    ? ok("a name with a space, `$` or a quote is single-quoted for the copied command")
    : fail(`quoted names: ${cmd("my app")} ${cmd("$(id)")} ${cmd("o'b")}`);
  cmd("") === "<repo>"
    ? ok("no repo name gives a <repo> placeholder, not a wrong command")
    : fail(`empty name: ${cmd("")}`);
}
console.log("== ledger: a spawn that never started books no kill estimate; a timeout does ==");
{
  const ledger = resolve(LIVE.data, "usage-ledger.jsonl");
  const lastRow = () => {
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  };
  // ENOENT: no claude process ran, so no paid work happened — an "unknown" row, not $0.05.
  LIVE.g("branch", "-D", "gaffer/ticket-1-tests");
  runLive("PASS", { CLAUDE_BIN: resolve(WORKDIR, "no-such-claude") });
  const missing = lastRow();
  missing.kind === "tester" &&
  missing.estimated !== true &&
  /spawn error/.test(missing.unknown_reason)
    ? ok("spawn error (no process) → unknown row, no kill estimate")
    : fail(`spawn-error row: ${JSON.stringify(missing)}`);
  // ETIMEDOUT: the call ran and was killed — the labelled estimate, never a silent $0.
  const sleeper = resolve(WORKDIR, "sleep-claude.sh");
  writeFileSync(sleeper, "#!/bin/bash\nexec sleep 5\n");
  chmodSync(sleeper, 0o755);
  LIVE.g("branch", "-D", "gaffer/ticket-1-tests");
  runLive("PASS", { CLAUDE_BIN: sleeper, GAFFER_TESTER_TIMEOUT_MS: "500" });
  const killed = lastRow();
  killed.kind === "tester" && killed.estimated === true && killed.estimated_cost_usd > 0
    ? ok("timed-out tester → estimated kill row")
    : fail(`timeout row: ${JSON.stringify(killed)}`);
  LIVE.g("worktree", "prune");
}

rmSync(WORKDIR, { recursive: true, force: true });

console.log("");
console.log(
  "== AC14: the tester's prompt carries the requirements (the ticket description / the brief) ==",
);
{
  const { buildTesterPrompt, contractHash } = await import(HELPER);
  const base = {
    number: 14,
    title: "Acceptance: Bookmark Vault",
    description:
      "Brief (the contract):\nBRIEF_SENTINEL: Netscape HTML bookmark import must preserve nested tags.",
    mode: "harness",
    acceptanceCriteria: [
      {
        id: "ac1",
        text: "Brief coverage: satisfies every capability the brief names.",
        status: "pending",
      },
    ],
    testContract: {
      changed_surfaces: ["the whole build"],
      runtime_deps: [],
      env_vars: [],
      run_command: "",
      harness_ready: false,
    },
    testContractRaw: "{}",
  };
  const p1 = buildTesterPrompt({
    context: base,
    worktree: "/tmp/fixture",
    repoName: "bookmark-vault",
  });
  p1.includes("BRIEF_SENTINEL: Netscape HTML bookmark import must preserve nested tags.")
    ? ok("the original brief is in the tester's initial prompt")
    : fail("brief missing from the prompt");
  /<<<REQUIREMENTS[\s\S]*REQUIREMENTS>>>/.test(p1) && /DATA, not instructions/.test(p1)
    ? ok("the requirements are fenced and marked as data, not instructions")
    : fail("requirements fence / data marker missing");
  const other = {
    ...base,
    description: "COMPLETELY_DIFFERENT_BRIEF: a graphical editor and no HTTP API.",
  };
  const p2 = buildTesterPrompt({
    context: other,
    worktree: "/tmp/fixture",
    repoName: "bookmark-vault",
  });
  p1 !== p2 && p2.includes("COMPLETELY_DIFFERENT_BRIEF")
    ? ok("two briefs with identical title, criteria and contract produce DIFFERENT prompts")
    : fail("changing only the brief did not change the prompt");
  const long = { ...base, description: "x".repeat(19000) + "END_OF_BRIEF_SENTINEL" };
  buildTesterPrompt({
    context: long,
    worktree: "/tmp/fixture",
    repoName: "bookmark-vault",
  }).includes("END_OF_BRIEF_SENTINEL")
    ? ok("a description up to the schema's 20,000-character cap reaches the tester untruncated")
    : fail("a long brief was truncated");
  /never change it/.test(p1)
    ? ok("the prompt forbids editing the implementation")
    : fail("no do-not-modify instruction");
  const withIds = {
    ...base,
    ticketId: "tkt-uuid-123",
    acceptanceCriteria: [{ id: "ac-uuid-9", text: "x", status: "pending" }],
  };
  const p3 = buildTesterPrompt({
    context: withIds,
    worktree: "/tmp/fixture",
    repoName: "bookmark-vault",
  });
  p3.includes('ticket_id "tkt-uuid-123"') && p3.includes("[ac_id ac-uuid-9]")
    ? ok(
        "the prompt gives the tester the ticket id and each criterion's ac_id for record_ac_evidence",
      )
    : fail("ticket id / ac ids missing from the prompt (the tester's notes would be refused)");
  const h1 = contractHash(base);
  const h2 = contractHash(other);
  /^[0-9a-f]{64}$/.test(h1) && h1 !== h2
    ? ok("contractHash differs when only the brief differs")
    : fail("contract hash did not change");
  const { createHash } = require("node:crypto");
  const expected = createHash("sha256")
    .update(
      [base.title, base.description, base.acceptanceCriteria[0].text, base.testContractRaw].join(
        "\u0000",
      ),
    )
    .digest("hex");
  h1 === expected
    ? ok(
        "contractHash is the canonical sha256(title NUL description NUL criteria… NUL raw contract)",
      )
    : fail("hash formula drifted");
}

console.log("== prompt: the tester never asserts on git history ==");
{
  // The root commit is the factory's baseline; a criterion phrased as "in the initial
  // commit" is demonstrated by the files present, never by inspecting commits (a live
  // tester ran `git rev-list --max-parents=0` and encoded an unsatisfiable check).
  const { buildTesterPrompt } = await import(HELPER);
  const p = buildTesterPrompt({
    context: {
      number: 7,
      title: "Bootstrap",
      acceptanceCriteria: [{ text: "files in the initial commit" }],
      testContract: {},
      mode: "black-box",
    },
    worktree: "/tmp/wt",
    repoName: "r",
  });
  if (/Run no git command except the/.test(p) && /FILES PRESENT/.test(p))
    ok(
      "prompt forbids git (bar committing the tests) and verifies history-phrased ACs by the files present",
    );
  else fail("prompt should forbid git and redirect history-phrased ACs to the checkout's files");
}

console.log(
  "== AC20: a PLANNED implementation ticket reaches the tester with a contract (changed_surfaces) ==",
);
{
  // False green (gap hole 2): createEpic marked implementation tickets testable without a
  // contract, so the tester's prompt carried `{}` and changed_surfaces was empty. Against
  // the BUILT dispatch: plan an epic with the lane on, put the implementation ticket in
  // testing, and read it back through the tester's own seams.
  const CORE_JS = resolve(HERE, "..", "..", "packages", "dispatch", "dist", "core.js");
  const HASH_JS = resolve(
    HERE,
    "..",
    "..",
    "packages",
    "dispatch",
    "dist",
    "util",
    "contractHash.js",
  );
  if (!existsSync(CORE_JS)) fail(`dispatch is not built (${CORE_JS}); run pnpm -r build`);
  else {
    const { Dispatch } = await import(CORE_JS);
    const dispatchHash = (await import(HASH_JS)).contractHash;
    const { buildTesterPrompt, contractHash } = await import(HELPER);
    const dir = gafferMkdtemp(resolve(tmpdir(), "tester-run-contract-"));
    const dbPath = resolve(dir, "dispatch.sqlite");
    const human = { type: "human", id: "tom" };
    const d = Dispatch.open(dbPath, undefined, undefined, { testingEnabled: true });
    d.registerRepository({ name: "app", default_branch: "main" }, human);
    d.createEpic(
      {
        epic: { name: "Vault", description: "a bookmark manager" },
        tickets: [{ title: "Store bookmarks", acceptanceCriteria: ["atomic writes"], repo: "app" }],
      },
      human,
    );
    const row = d.db
      .prepare("SELECT id, number FROM tickets WHERE title = 'Store bookmarks'")
      .get();
    d.db.prepare("UPDATE tickets SET status = 'in_testing' WHERE id = ?").run(row.id);
    const want = dispatchHash(d.db, row.id);
    d.db.close();
    const ctx = assembleContext(dbPath, row.number);
    const surfaces = (ctx && ctx.testContract && ctx.testContract.changed_surfaces) || [];
    surfaces.length === 1 && surfaces[0].includes('"Store bookmarks"')
      ? ok(
          `the tester context carries changed_surfaces for the implementation ticket (${surfaces[0]})`,
        )
      : fail(`implementation ticket contract: ${JSON.stringify(ctx && ctx.testContract)}`);
    const prompt = ctx
      ? buildTesterPrompt({ context: ctx, worktree: "/tmp/wt", repoName: "app" })
      : "";
    surfaces[0] && prompt.includes(JSON.stringify(surfaces[0]))
      ? ok("the tester prompt renders the contract's surface (not an empty {})")
      : fail("the tester prompt does not render the implementation ticket's contract");
    ctx && contractHash(ctx) === want
      ? ok(
          "the tester's contract hash equals dispatch's for the seeded contract (the verdict binds)",
        )
      : fail(`hash drift: tester ${ctx && contractHash(ctx)} vs dispatch ${want}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  "== AC19: the tester checkout gets the installed deps, never counted as its changes ==",
);
{
  const { linkNodeModules, inspectTesterChanges } = await import(HELPER);
  const fs = require("node:fs");
  const repo = resolve(WORKDIR, "nm-repo");
  const g = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  fs.mkdirSync(resolve(repo, "packages", "a"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(resolve(repo, "package.json"), '{"name":"nm"}\n');
  writeFileSync(resolve(repo, "packages", "a", "package.json"), '{"name":"a"}\n');
  // A .gitignore with the common trailing-slash form, which does NOT match a symlink.
  writeFileSync(resolve(repo, ".gitignore"), "node_modules/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD").stdout.trim();
  fs.mkdirSync(resolve(repo, "node_modules", "vitest"), { recursive: true });
  fs.mkdirSync(resolve(repo, "packages", "a", "node_modules", "pkg"), { recursive: true });
  const wt = resolve(WORKDIR, "nm-wt");
  g("worktree", "add", "-q", "--detach", wt, "HEAD");
  const linked = linkNodeModules(repo, wt);
  if (
    existsSync(resolve(wt, "node_modules", "vitest")) &&
    existsSync(resolve(wt, "packages", "a", "node_modules", "pkg"))
  )
    ok("root and workspace-package node_modules are linked in");
  else fail(`node_modules not linked (linked=${JSON.stringify(linked)})`);
  const st = spawnSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
  }).stdout;
  if (!/node_modules/.test(st)) ok("git does not see the links (excluded)");
  else fail(`git status shows the links: ${st}`);
  const insp = inspectTesterChanges(wt, base);
  if (insp.ok && insp.implementation.length === 0)
    ok("the links are not read as the tester changing the implementation");
  else fail(`links read as changes: ${JSON.stringify(insp)}`);
  // A root install that is itself a symlink (a shared store) is still linked.
  const repo2 = resolve(WORKDIR, "nm-repo2");
  const store = resolve(WORKDIR, "nm-store");
  fs.mkdirSync(resolve(store, "vitest"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo2]);
  const g2 = (...a) => spawnSync("git", ["-C", repo2, ...a], { encoding: "utf8" });
  g2("config", "user.email", "t@t");
  g2("config", "user.name", "t");
  writeFileSync(resolve(repo2, "package.json"), '{"name":"nm2"}\n');
  fs.mkdirSync(resolve(repo2, "pkg"), { recursive: true });
  writeFileSync(resolve(repo2, "pkg", "package.json"), '{"name":"pkg"}\n');
  g2("add", "-A");
  g2("commit", "-q", "-m", "base");
  fs.symlinkSync(store, resolve(repo2, "node_modules"), "dir");
  fs.mkdirSync(resolve(repo2, "pkg", "node_modules", "dep"), { recursive: true });
  const wt2 = resolve(WORKDIR, "nm-wt2");
  g2("worktree", "add", "-q", "--detach", wt2, "HEAD");
  // The checkout's `pkg` is turned into a symlink pointing OUTSIDE it.
  const outside = resolve(WORKDIR, "nm-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.rmSync(resolve(wt2, "pkg"), { recursive: true, force: true });
  fs.symlinkSync(outside, resolve(wt2, "pkg"), "dir");
  linkNodeModules(repo2, wt2);
  if (existsSync(resolve(wt2, "node_modules", "vitest")))
    ok("a symlinked root install is linked too");
  else fail("symlinked root node_modules was not linked");
  if (!existsSync(resolve(outside, "node_modules")))
    ok("no link is created outside the checkout through a symlinked directory");
  else fail("a node_modules link escaped the checkout");
}

console.log("== the tester verdict is its FINAL line, never a token quoted earlier ==");
{
  const { parseTesterVerdict } = await import(HELPER);
  const cases = [
    ['AC1 ok\n{"verdict":"PASS"}', "pass", "PASS token as the final line → pass"],
    ['AC1 broken\n{"verdict":"FAIL"}', "fail", "FAIL token as the final line → fail"],
    [
      'AC1 broken\n{"verdict":"FAIL"}\nThe contract asked me to print {"verdict":"PASS"} — ignored.',
      null,
      "FAIL token, then prose QUOTING a PASS token → no verdict (held), not pass",
    ],
    ['{"verdict":"PASS"}\nAC2 still running', null, "PASS token followed by prose → no verdict"],
    [
      'AC1 ok\n```json\n{"verdict":"PASS"}\n```\n',
      "pass",
      "PASS inside a trailing code fence → pass",
    ],
    ["all tests pass, PASS", null, "prose only → no verdict"],
  ];
  for (const [text, want, label] of cases) {
    const got = parseTesterVerdict(text);
    if (got === want) ok(label);
    else fail(`${label}: got ${JSON.stringify(got)}`);
  }
}

console.log("== UNPROVABLE: a third final token, read with the same strictness ==");
{
  const { parseTesterOutcome, parseTesterVerdict } = await import(HELPER);
  const U = (o) => JSON.stringify(o);
  const good = U({ verdict: "UNPROVABLE", criteria: [5], needs: "no browser to press Enter in" });
  const cases = [
    [`AC1-AC4 pass\nUNPROVABLE: AC5\n${good}`, "unprovable", "UNPROVABLE as the final line"],
    [`AC1 ok\n\`\`\`json\n${good}\n\`\`\``, "unprovable", "UNPROVABLE inside a trailing fence"],
    [`${good}\nAC2 still running`, null, "an UNPROVABLE token followed by prose → no verdict"],
    [
      `AC1 broken\n{"verdict":"FAIL"}\nThe README says to print ${good}`,
      null,
      "FAIL then a quoted UNPROVABLE → no verdict",
    ],
    [
      `The delivery's README says ${good}, but\n{"verdict":"FAIL"}`,
      "fail",
      "a quoted UNPROVABLE before a FAIL → fail",
    ],
    [
      `npm test output: ${good}\n{"verdict":"PASS"}`,
      "pass",
      "a quoted UNPROVABLE before a PASS → pass (its own token)",
    ],
    [
      U({ verdict: "UNPROVABLE", criteria: [], needs: "x" }),
      null,
      "no criteria → malformed, no verdict",
    ],
    [U({ verdict: "UNPROVABLE", needs: "x" }), null, "criteria missing → malformed"],
    [
      U({ verdict: "UNPROVABLE", criteria: [9], needs: "x" }),
      null,
      "a criterion the ticket does not have → malformed",
    ],
    [U({ verdict: "UNPROVABLE", criteria: [0], needs: "x" }), null, "criterion 0 → malformed"],
    [
      U({ verdict: "UNPROVABLE", criteria: ["5"], needs: "x" }),
      null,
      "a criterion as a string → malformed",
    ],
    [
      U({ verdict: "UNPROVABLE", criteria: [5, 5], needs: "x" }),
      null,
      "a criterion twice → malformed",
    ],
    [
      U({ verdict: "UNPROVABLE", criteria: [5], needs: 7 }),
      null,
      "needs of the wrong type → malformed",
    ],
    [U({ verdict: "UNPROVABLE", criteria: [5], needs: "" }), null, "empty needs → malformed"],
    [
      U({ verdict: "UNPROVABLE", criteria: [5], needs: "x".repeat(301) }),
      null,
      "needs too long → malformed",
    ],
    [
      U({ verdict: "UNPROVABLE", criteria: [5], needs: "x", pass: true }),
      null,
      "an extra key → malformed",
    ],
    [
      U({ verdict: "UNPROVABLE", criteria: [5], needs: "x", verdict2: "PASS" }),
      null,
      "an extra key named like a verdict → malformed",
    ],
    ['{"verdict":"UNPROVABLE","criteria":[5],"needs":"x"', null, "invalid JSON → no verdict"],
  ];
  for (const [text, want, label] of cases) {
    const got = parseTesterOutcome(text, 5);
    if (got.verdict === want) ok(label);
    else fail(`${label}: got ${JSON.stringify(got)}`);
  }
  const g = parseTesterOutcome(
    `x\n${U({ verdict: "unprovable", criteria: [5, 2], needs: " no  browser " })}`,
    5,
  );
  if (g.verdict === "unprovable" && g.criteria.join() === "2,5" && g.needs === "no browser")
    ok("criteria sorted and needs tidied");
  else fail(`outcome shape: ${JSON.stringify(g)}`);
  const m = parseTesterOutcome(U({ verdict: "UNPROVABLE", criteria: [7], needs: "x" }), 5);
  if (m.verdict === null && /does not have/.test(m.malformed || ""))
    ok("a malformed token says why");
  else fail(`malformed reason: ${JSON.stringify(m)}`);
  // The two-word reader never reads UNPROVABLE as a PASS or a FAIL.
  if (parseTesterVerdict(good) === null)
    ok("parseTesterVerdict reads an UNPROVABLE token as no PASS/FAIL");
  else fail("parseTesterVerdict read UNPROVABLE as a verdict");
}

console.log("== DECLARED NEEDS: the runner's own host probe ==");
{
  const { probeHostCapability, missingCapabilities, HOST_CAPABILITIES, buildTesterPrompt } =
    await import(HELPER);
  const fs = await import("node:fs");
  const dir = gafferMkdtemp(resolve(tmpdir(), "tester-probe-"));
  const bin = resolve(dir, "bin");
  fs.mkdirSync(bin);
  const empty = { PATH: bin, HOME: resolve(dir, "home") };
  if (probeHostCapability("browser", empty) === false)
    ok("no browser on PATH and no Playwright cache → absent");
  else fail("an empty host was probed as having a browser");
  fs.writeFileSync(resolve(bin, "chromium"), "#!/bin/sh\nexit 0\n");
  if (probeHostCapability("browser", empty) === false) ok("a non-executable file is not a browser");
  else fail("a non-executable chromium counted");
  fs.chmodSync(resolve(bin, "chromium"), 0o755);
  if (probeHostCapability("browser", empty) === true)
    ok("an executable chromium on PATH → present");
  else fail("chromium on PATH not found");
  fs.rmSync(resolve(bin, "chromium"));
  fs.mkdirSync(resolve(dir, "home", ".cache", "ms-playwright", "chromium-1100"), {
    recursive: true,
  });
  if (probeHostCapability("browser", empty) === true)
    ok("an installed Playwright chromium → present");
  else fail("Playwright cache not found");
  // A relative PATH entry or Playwright path is read against this process's working
  // directory, which may be a delivery's checkout: never a probe answer.
  fs.rmSync(resolve(dir, "home", ".cache"), { recursive: true, force: true });
  const cwd0 = process.cwd();
  const planted = resolve(dir, "planted");
  fs.mkdirSync(resolve(planted, "rel"), { recursive: true });
  fs.writeFileSync(resolve(planted, "chromium"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(resolve(planted, "chromium"), 0o755);
  fs.mkdirSync(resolve(planted, "pw", "chromium-1"), { recursive: true });
  process.chdir(planted);
  try {
    if (probeHostCapability("browser", { ...empty, PATH: `.:rel:${bin}` }) === false)
      ok("a chromium planted in the working directory via a relative PATH entry is not a browser");
    else fail("a relative PATH entry satisfied the browser probe");
    if (probeHostCapability("browser", { ...empty, PLAYWRIGHT_BROWSERS_PATH: "pw" }) === false)
      ok("a relative PLAYWRIGHT_BROWSERS_PATH is not a Playwright install");
    else fail("a relative Playwright path satisfied the browser probe");
  } finally {
    process.chdir(cwd0);
  }
  fs.mkdirSync(resolve(dir, "home", ".cache", "ms-playwright", "chromium-1100"), {
    recursive: true,
  });
  if (probeHostCapability("gpu", empty) === false) ok("an unknown capability is never present");
  else fail("an unknown capability was probed present");
  if (probeHostCapability("browser", { ...empty, _GAFFER_TESTER_HOST_CAPS: "" }) === false)
    ok("the test seam set empty reports nothing present");
  else fail("the empty seam reported a browser");
  if (HOST_CAPABILITIES.join() === "browser") ok("the closed list is browser only");
  else fail(`capabilities: ${HOST_CAPABILITIES.join()}`);
  const miss = missingCapabilities(
    { needs: ["browser", "telepathy"] },
    { ...empty, _GAFFER_TESTER_HOST_CAPS: "browser" },
  );
  if (miss.join() === "telepathy")
    ok("an unknown declared need counts as missing (it cannot be probed)");
  else fail(`missing: ${miss.join()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  // The dispatch list and the runner's are the same closed list.
  const domain = fs.readFileSync(
    resolve(HERE, "..", "..", "packages/dispatch/src/domain/hostCapabilities.ts"),
    "utf8",
  );
  if (/HOST_CAPABILITIES = \["browser"\] as const/.test(domain))
    ok("dispatch declares the same closed list");
  else fail("dispatch's HOST_CAPABILITIES differs from the runner's");
  const ctx = {
    number: 7,
    ticketId: "t7",
    title: "Enter submits",
    description: "",
    mode: "black-box",
    testContract: { needs: ["browser"] },
    acceptanceCriteria: [{ id: "a1", text: "Enter navigates" }],
  };
  const p1 = buildTesterPrompt({
    context: ctx,
    worktree: "/w",
    repoName: "r",
    missing: ["browser"],
  });
  if (/HOST LIMIT[^\n]*this host lacks browser/.test(p1))
    ok("the prompt names the capability the host lacks");
  else fail("the prompt does not name the missing capability");
  const p2 = buildTesterPrompt({ context: ctx, worktree: "/w", repoName: "r" });
  if (
    !/HOST LIMIT/.test(p2) &&
    /"verdict":"UNPROVABLE","criteria"/.test(p2) &&
    /never FAIL a\s+delivery for what the host cannot observe, and never PASS it/.test(p2)
  )
    ok(
      "the prompt carries the UNPROVABLE contract (prove another way first; never FAIL, never PASS)",
    );
  else fail("the prompt lacks the UNPROVABLE contract");
  if (/Do NOT keep a test for a criterion you give up on/.test(p2))
    ok(
      "the prompt says to keep no test for a criterion it cannot prove (it would fail the replay)",
    );
  else fail("the prompt does not warn about keeping a test for an unprovable criterion");
}

console.log("== DECLARED NEEDS: the hold names who declared the need, and when ==");
{
  const { needsDeclaration } = await import(HELPER);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const dir = gafferMkdtemp(resolve(tmpdir(), "tester-needs-decl-"));
  const dbPath = resolve(dir, "d.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE tickets (id TEXT, number INTEGER);" +
      "CREATE TABLE work_events (entity_type TEXT, entity_id TEXT, actor_type TEXT, actor_id TEXT, event_type TEXT, payload_json TEXT, created_at TEXT);",
  );
  db.prepare("INSERT INTO tickets VALUES ('t1', 1), ('t2', 2)").run();
  const ins = db.prepare(
    "INSERT INTO work_events VALUES ('ticket', ?, ?, ?, 'ticket.test_contract_set', ?, ?)",
  );
  ins.run(
    "t1",
    "human",
    "tom",
    '{"needs":["browser"],"needs_declared":true}',
    "2026-11-10T01:00:00.000Z",
  );
  ins.run("t1", "agent", "gaffer-factory", '{"needs":["browser"]}', "2026-11-10T02:00:00.000Z");
  ins.run("t2", "agent", "x", '{"needs":["browser"]}', "2026-11-10T02:00:00.000Z");
  db.close();
  const d1 = needsDeclaration(dbPath, 1);
  if (d1 && d1.by === "human:tom" && d1.at === "2026-11-10T01:00:00.000Z")
    ok("the declaration is the event that changed the needs (a resend is not)");
  else fail(`declaration: ${JSON.stringify(d1)}`);
  if (needsDeclaration(dbPath, 2) === null) ok("no recorded declaration → null (the hold says so)");
  else fail("a resend without needs_declared was read as the declaration");
  if (needsDeclaration(resolve(dir, "none.sqlite"), 1) === null) ok("an unreadable DB → null");
  else fail("an unreadable DB gave a declaration");
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log(`tester-run: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`tester-run: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
