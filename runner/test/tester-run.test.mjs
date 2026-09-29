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
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
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
const { assembleContext } = await import(HELPER);

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
const WORKDIR = mkdtempSync(resolve(tmpdir(), "tester-run-test-"));
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
      "can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT);" +
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

// ── AC10–AC12: --live runs the INDEPENDENT tester agent lane end to end (stub claude) ──
console.log(
  "== AC10: --live spawns the tester in a worktree of the delivery branch and records PASS ==",
);
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
    "CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main', stack TEXT);" +
      "CREATE TABLE IF NOT EXISTS ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT DEFAULT 'primary', branch_name TEXT, access TEXT DEFAULT 'write');",
  );
  db.prepare(
    "INSERT INTO repositories (id,name,local_path,default_branch,stack) VALUES (?,?,?,?,?)",
  ).run("r1", "live", repo, "main", "typescript-node");
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
      // TESTER_STUB_MUTATE=1: the agent "fixes" the implementation to make its test pass —
      // the verdict is then not about the candidate and must be HELD, never recorded.
      '[ "${TESTER_STUB_MUTATE:-0}" = "1" ] && printf \'export const w = 2; // tester edit\\n\' > src/w.js\n' +
      // The agent COMMITS in the worktree (seen live): with a detached HEAD this can never
      // advance the reviewed delivery branch; the commit is moved to the tests branch.
      'git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -q -m "agent committed its tests" >/dev/null 2>&1 || true\n' +
      'case "${TESTER_STUB_VERDICT:-PASS}" in\n' +
      '  PASS) printf \'{"type":"result","subtype":"success","is_error":false,"result":"PASS: every AC demonstrated\\\\n{\\\\"verdict\\\\":\\\\"PASS\\\\"}","total_cost_usd":0.01,"num_turns":3}\\n\' ;;\n' +
      '  FAIL) printf \'{"type":"result","subtype":"success","is_error":false,"result":"FAIL: AC1 POST /api/widgets returned 500, expected 201\\\\n{\\\\"verdict\\\\":\\\\"FAIL\\\\"}","total_cost_usd":0.01,"num_turns":3}\\n\' ;;\n' +
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
  const data = resolve(WORKDIR, "data");
  require("node:fs").mkdirSync(data, { recursive: true });
  return { repo, g, deliverySha, stub, capture, verdictStub, data };
})();
function runLive(verdictMode, extraEnv = {}) {
  if (existsSync(STUB_LOG)) rmSync(STUB_LOG);
  if (existsSync(LIVE.capture)) rmSync(LIVE.capture);
  const { code, out } = runCli(["--ticket", "1", "--live"], {
    GAFFER_DATA: LIVE.data,
    CLAUDE_BIN: LIVE.stub,
    CLAUDE_FLAGS: "",
    TESTER_STUB_VERDICT: verdictMode,
    ...extraEnv,
    DISPATCH_TESTER_VERDICT_CMD: JSON.stringify([process.execPath, LIVE.verdictStub]),
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
  // ACCEPTANCE GATE: the verdict is bound to the tested commit and the contract hash.
  logged.includes('"--tested-commit"') && logged.includes(JSON.stringify(LIVE.deliverySha))
    ? ok("verdict carries --tested-commit <the delivery head it ran against>")
    : fail(`no tested-commit binding in the verdict argv: ${logged}`);
  /"--contract-hash","[0-9a-f]{64}"/.test(logged)
    ? ok("verdict carries --contract-hash <sha256 of the contract>")
    : fail(`no contract-hash binding in the verdict argv: ${logged}`);
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
  const testsSha = LIVE.g("rev-parse", "--verify", "gaffer/ticket-1-tests").status;
  testsSha === 0 && LIVE.g("show", "gaffer/ticket-1-tests:test/bb.test.js").status === 0
    ? ok("the tester's tests are kept on gaffer/ticket-1-tests")
    : fail("tests branch missing or without the test file");
  out && out.testsBranch === "gaffer/ticket-1-tests"
    ? ok("emitted JSON names the tests branch")
    : fail(`testsBranch: ${out && out.testsBranch}`);
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
  LIVE.g("branch", "-D", "gaffer/ticket-1-tests");
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
  LIVE.g("branch", "-D", "gaffer/ticket-1-tests");
  const { code, out, logged } = runLive("NONE");
  code === 2 && out && out.phase === "held"
    ? ok("no token → phase=held, exit 2")
    : fail(`held wrong (code=${code}, out=${JSON.stringify(out)})`);
  logged === ""
    ? ok("no verdict recorded on silence (never a pass)")
    : fail(`seam was invoked: ${logged}`);
}

console.log(
  "== AC13: --live HOLDS when the tester modified the implementation (verdict not about the candidate) ==",
);
{
  LIVE.g("branch", "-D", "gaffer/ticket-1-tests");
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
  /never change it/.test(p1)
    ? ok("the prompt forbids editing the implementation")
    : fail("no do-not-modify instruction");
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
  if (/Do not run git at all/.test(p) && /FILES PRESENT/.test(p))
    ok("prompt forbids git and verifies history-phrased ACs by the files present");
  else fail("prompt should forbid git and redirect history-phrased ACs to the checkout's files");
}

if (failures.length === 0) {
  console.log(`tester-run: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`tester-run: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
