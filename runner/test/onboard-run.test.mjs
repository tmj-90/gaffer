#!/usr/bin/env node
// =====================================================================
// `onboard-run` helper (bin/onboard-run.mjs) — target resolution + crew argv
// + the unconfigured-target refusal, proven WITHOUT a live crew call.
// ---------------------------------------------------------------------
// The dashboard Memory view's "Onboard a repo" button (POST /repos/onboard) spawns
// DISPATCH_ONBOARD_CMD with DISPATCH_ONBOARD_REPO in the child env (a registered
// repo name/id OR a local path). THIS helper is that command; it resolves the target
// to an on-disk path and runs crew's real `repo onboard <path> --standalone`.
//
// Against the REAL helper (imported functions + a real --dry-run subprocess over a
// throwaway sqlite DB), proves:
//   AC1  resolveTarget takes an existing directory path straight through
//   AC2  resolveTarget maps a registered repo NAME → its local_path
//   AC3  resolveTarget maps a registered repo ID → its local_path
//   AC4  resolveTarget returns null for an unknown name + missing db + blank
//   AC5  buildCrewArgv = [<cli>, -c, <config>, repo, onboard, <path>, --standalone]
//   AC6  --dry-run resolves DISPATCH_ONBOARD_REPO (a path) → planned crew argv
//   AC7  --dry-run resolves a registered NAME → the repo's path
//   AC8  a missing DISPATCH_ONBOARD_REPO is REFUSED (exit 1, error JSON)
//   AC9  an unresolvable target is REFUSED (exit 1, error JSON)
//   S1   --summary: ≤10 stderr lines (repo, test command, intake decision, next step),
//        the full log in $GAFFER_DATA/onboard.log; no flag → the full log as before
//
// Zero deps (node:sqlite ships with Node 22+). Run: node test/onboard-run.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
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
const HELPER = resolve(HERE, "..", "bin", "onboard-run.mjs");
const { resolveTarget, resolveRepoPath, buildCrewArgv } = await import(HELPER);

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

// --- Build a throwaway dispatch sqlite with the one table resolveRepoPath reads. ---
const WORKDIR = mkdtempSync(resolve(tmpdir(), "onboard-run-test-"));
const DB_PATH = resolve(WORKDIR, "dispatch.sqlite");
const REPO_PATH = resolve(WORKDIR, "demo-repo");
mkdirSync(REPO_PATH, { recursive: true });
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
      "local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main');",
  );
  db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
    "r1",
    "demo",
    REPO_PATH,
    "main",
  );
  db.close();
}

const CREW_DIR = resolve(WORKDIR, "crew");
const CREW_CONFIG = resolve(WORKDIR, "crew.yaml");
const CREW_CLI = resolve(CREW_DIR, "dist", "cli", "index.js");

// Run the helper as a CLI with --dry-run; return { code, out }.
function runCli(env = {}) {
  const res = spawnSync(process.execPath, [HELPER, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_DB: DB_PATH,
      CREW_DIR,
      CREW_CONFIG,
      ...env,
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out };
}

console.log("== AC1: resolveTarget takes an existing directory path straight through ==");
eq("existing dir → that path", resolveTarget(DB_PATH, REPO_PATH), REPO_PATH);

console.log("== AC2: resolveTarget maps a registered repo NAME → local_path ==");
eq("known name → its path", resolveTarget(DB_PATH, "demo"), REPO_PATH);

console.log("== AC3: resolveTarget maps a registered repo ID → local_path ==");
eq("known id → its path", resolveTarget(DB_PATH, "r1"), REPO_PATH);

console.log("== AC4: resolveTarget/resolveRepoPath null for unknown / missing db / blank ==");
eq("unknown name → null", resolveTarget(DB_PATH, "nope"), null);
eq("blank → null", resolveTarget(DB_PATH, "   "), null);
eq("missing db → null", resolveRepoPath(resolve(WORKDIR, "absent.sqlite"), "demo"), null);

console.log(
  "== AC5: buildCrewArgv = [<cli>, -c, <config>, repo, onboard, <path>, --standalone] ==",
);
{
  const argv = buildCrewArgv({
    crewDir: CREW_DIR,
    crewConfig: CREW_CONFIG,
    repoPath: REPO_PATH,
  });
  eq("crew onboard argv shape", argv, [
    CREW_CLI,
    "-c",
    CREW_CONFIG,
    "repo",
    "onboard",
    REPO_PATH,
    "--standalone",
  ]);
}

console.log("== AC6: --dry-run resolves a PATH target → planned crew argv ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: REPO_PATH });
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.repoPath === REPO_PATH &&
    Array.isArray(out.argv) &&
    out.argv.includes("onboard") &&
    out.argv.includes("--standalone") &&
    out.argv[0] === CREW_CLI
  ) {
    ok("dry-run path target → exit 0 + planned crew onboard argv");
  } else fail(`dry-run path wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC7: --dry-run resolves a registered NAME → the repo's path ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "demo" });
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.repo === "demo" &&
    out.repoPath === REPO_PATH
  ) {
    ok("dry-run name target → resolved to its registered path");
  } else fail(`dry-run name wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC8: a missing DISPATCH_ONBOARD_REPO is REFUSED ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "" });
  if (code !== 0 && out && out.phase === "error" && /required/i.test(out.error)) {
    ok("missing target → exit 1 + error JSON");
  } else fail(`missing-target refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC9: an unresolvable target is REFUSED ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "definitely-not-a-repo" });
  if (code !== 0 && out && out.phase === "error" && /resolve/i.test(out.error)) {
    ok("unresolvable target → exit 1 + error JSON");
  } else fail(`unresolvable refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

// ── --summary: the terminal view `gaffer onboard` passes ───────────────────────────
// gaffer onboard filtered with `grep -vE '^\{.*\}$'`, which only drops single-line JSON;
// crew prints its onboard result pretty-printed, so ~150 lines of raw JSON reached the
// terminal and buried the facts a user needs next.
console.log("== --summary: a short summary on stderr, the full log in $GAFFER_DATA/onboard.log ==");
{
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const work = mkdtempSync(resolve(tmpdir(), "onboard-summary-"));
  const crewDir = resolve(work, "crew");
  mkdirSync(resolve(crewDir, "dist", "cli"), { recursive: true });
  const crewOut = {
    ok: true,
    onboarded: {
      repoId: "notes",
      name: "notes",
      scan: { stack: "node", testCommand: "npm run test", defaultBranch: "main", riskSignals: [] },
      profile: {
        repoId: "notes",
        name: "notes",
        mapping: { mode: "standalone", scopeNodeIds: [] },
      },
      registration: { repoId: "a9c704b9", attachedScopeIds: [] },
    },
    clarifications: Array.from({ length: 8 }, (_, i) => ({
      topic: `t${i}`,
      question: `Question ${i}?`,
      decisionId: "699ebe38-c214-467c-92a7-f6f9e5f31f2e",
    })),
  };
  writeFileSync(
    resolve(crewDir, "dist", "cli", "index.js"),
    `process.stdout.write(${JSON.stringify(JSON.stringify(crewOut, null, 2))} + "\\n");\n`,
  );
  const data = resolve(work, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(resolve(data, "crew.yaml"), "dispatch:\n  local:\n    sqlite_path: x\n");
  const repoDir = resolve(work, "notes");
  mkdirSync(repoDir, { recursive: true });
  const run = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [HELPER, "--repo", repoDir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GAFFER_DATA: data,
        CREW_DIR: crewDir,
        CREW_CONFIG: resolve(data, "crew.yaml"),
        DISPATCH_DB: resolve(data, "dispatch.sqlite"),
        MEMORY_CLI_BIN: "",
        MEMORY_DB: "",
        GAFFER_VERBOSE: "",
        ...extraEnv,
      },
    });

  const sum = run(["--summary"]);
  const lines = sum.stderr.split("\n").filter((l) => l.trim().length > 0);
  if (sum.status === 0) ok("--summary run exits 0");
  else fail(`--summary exit ${sum.status}: ${sum.stderr}`);
  if (lines.length <= 10) ok(`--summary prints at most 10 lines (got ${lines.length})`);
  else fail(`--summary printed ${lines.length} lines:\n${sum.stderr}`);
  if (!lines.some((l) => /^\s+"/.test(l) || /^\s*[{}]\s*$/.test(l)))
    ok("no raw JSON lines in the summary");
  else fail(`raw JSON in the summary:\n${sum.stderr}`);
  if (/registered: notes/.test(sum.stderr) && /test "npm run test"/.test(sum.stderr))
    ok("names the registered repo and its test command");
  else fail(`summary lacks repo/test:\n${sum.stderr}`);
  if (/decision 699ebe38/.test(sum.stderr) && /decisions resolve 699ebe38/.test(sum.stderr))
    ok("names the intake decision and how to answer it");
  else fail(`no intake line:\n${sum.stderr}`);
  if (/^next: .*repo-access set <n> notes/m.test(sum.stderr))
    ok("prints the next step with the repo name");
  else fail(`no next line:\n${sum.stderr}`);
  const logFile = resolve(data, "onboard.log");
  if (existsSync(logFile) && readFileSync(logFile, "utf8").includes('"clarifications"'))
    ok("the full crew JSON is kept in $GAFFER_DATA/onboard.log");
  else fail("onboard.log missing the full output");
  let done = null;
  try {
    done = JSON.parse(sum.stdout.trim().split("\n").pop());
  } catch {
    /* leave null */
  }
  eq("stdout still carries the single-line done event", done?.phase, "done");

  const full = run([]);
  if (full.stderr.includes('"clarifications"') && !/registered: notes/.test(full.stderr))
    ok("without --summary the full JSON is still logged (dashboard run log unchanged)");
  else fail(`no-flag output changed:\n${full.stderr.slice(0, 300)}`);
  const verbose = run(["--summary"], { GAFFER_VERBOSE: "1" });
  if (verbose.stderr.includes('"clarifications"'))
    ok("GAFFER_VERBOSE=1 keeps the full log on stderr");
  else fail("GAFFER_VERBOSE=1 hid the full log");
}

console.log("");
if (failures.length === 0) {
  console.log(`onboard-run: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`onboard-run: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
