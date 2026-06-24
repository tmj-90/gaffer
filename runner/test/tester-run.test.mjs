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

rmSync(WORKDIR, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`tester-run: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`tester-run: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
